// The host's side of WasmHost.Bridge (src/bridge.jl; docs/bridge.md): values between the module and the page, both
// ways, on WasmHost.Page (js/common/page.mjs, the import library `wasm_host_page`). No Node or browser API is used.
//
//   const bridge = makeBridge({ events, onMessage: (value) => ..., onAsk: async (request) => answer });
//   const inst = await WebAssembly.instantiate(mod, { ...otherImports, ...bridge.imports });
//   bridge.bindMemory(inst.exports.memory);
//   bridge.post({ msg_type: '0', id: obsId, payload: ... });            // page -> module
//   bridge.close('page closed');                                        // the end: the module's recv and asks fail
//
// - Module to page: the module's `Page.send` of a frame; the bridge decodes it and calls `onMessage(value, bytes)` (or
//   `onAsk`, for a request of `Bridge.ask`). Synchronous: it never suspends the module. What `onMessage` throws goes
//   to `onError(error, value)` (Page's rule: nothing is thrown into the module); for an ask, it is the ask's error.
// - Page to module: `bridge.post(value)` queues a record (`u8 kind | frame`) in the bridge's own queue, which is the
//   page's `source`: the module's `Page.receive` takes the records one at a time, and its `Page.wait_message` (a
//   julia_io handle, `events`) is made ready by a post. So a page's event never calls into the module: it completes
//   a handle of the call in flight (which the module waits for as for a timer), or waits in the queue.
// - The queue is bounded (`capacity` frames, `maxBytes` bytes). When it is full, `overflow: 'reject'` (the default)
//   makes `post` throw a BridgeFullError and queue nothing (the page's backpressure: `room()` says how much fits);
//   `'drop-oldest'` drops the oldest frames to make room (for events that only matter as the latest state). The
//   first reply to each outstanding ask of the module is always queued (the module's asks bound them); `reply`
//   refuses (`false`) any other: an id not asked, or answered already.
// - Closing: `bridge.close(reason)` (the page goes away) drops the queue, queues the close (a record of its own
//   kind, with the reason) and wakes a parked receive: the module's `recv` throws a BridgeClosedError, its pending
//   asks too; `post` throws a BridgeClosedError. The module closes it too (`Bridge.close`, or its `serve` ending: a
//   `bridge_close` frame): `onClose(reason, 'module')`.
// - `guard`: the page's (js/common/page.mjs): a browser adapter's re-entry check of every import.
//
// A frame is `u32le header_length | header (JSON) | blobs`: typed arrays are in the blobs, 8-byte aligned, and the
// JSON holds `{"$b": [offset, bytes, "f32"]}` in their place; decoded they are typed arrays again. `NaN` and
// `Infinity` are `null` (JSON has no such numbers).
import { makePage } from './page.mjs';

const TAGS = [
  [Float32Array, 'f32'], [Float64Array, 'f64'], [Uint8Array, 'u8'], [Int8Array, 'i8'],
  [Int16Array, 'i16'], [Uint16Array, 'u16'], [Int32Array, 'i32'], [Uint32Array, 'u32'],
];
const ARRAYS = Object.fromEntries(TAGS.map(([C, t]) => [t, C]));
const tagOf = (v) => { for (const [C, t] of TAGS) if (v instanceof C) return t; return null; };
const BLOB_KEY = '$b';

export function encodeFrame(value) {
  const blobs = [];
  let size = 0;
  const json = JSON.stringify(value, function (k, v) {
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const tag = tagOf(v);
      if (tag === null) throw new Error(`wasmhost bridge: can't encode a ${v.constructor.name}`);
      size += (8 - (size % 8)) % 8;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      blobs.push([size, bytes]);
      const ref = { [BLOB_KEY]: [size, bytes.length, tag] };
      size += bytes.length;
      return ref;
    }
    if (typeof v === 'bigint') return Number(v);
    return v;
  });
  // (undefined, a function, a symbol: no JSON, which the module could not decode)
  if (json === undefined) throw new Error(`wasmhost bridge: can't encode ${typeof value === 'symbol' ? 'a symbol' : String(value)}: not a JSON value`);
  const header = new TextEncoder().encode(json);
  const start = 4 + header.length;
  const blobStart = start + ((8 - (start % 8)) % 8);
  const out = new Uint8Array(blobs.length ? blobStart + size : start);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  for (const [off, bytes] of blobs) out.set(bytes, blobStart + off);
  return out;
}

export function decodeFrame(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const hlen = dv.getUint32(0, true);
  if (4 + hlen > b.length) throw new Error('wasmhost bridge: a frame shorter than its header');
  const start = 4 + hlen;
  const blobStart = start + ((8 - (start % 8)) % 8);
  return JSON.parse(new TextDecoder().decode(b.subarray(4, start)), (k, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const ref = v[BLOB_KEY];
      if (Array.isArray(ref) && ref.length === 3 && Object.keys(v).length === 1) {
        const [off, n, tag] = ref;
        const C = ARRAYS[tag];
        if (!C) throw new Error(`wasmhost bridge: unknown blob type ${tag}`);
        // (an empty blob is empty wherever it points: a frame whose blobs are all empty has no blob region)
        if (n === 0 && Number.isInteger(off) && off >= 0) return new C(0);
        if (!(Number.isInteger(off) && Number.isInteger(n) && off >= 0 && n >= 0 && blobStart + off + n <= b.length && n % C.BYTES_PER_ELEMENT === 0))
          throw new Error('wasmhost bridge: a blob out of range');
        // (a copy of exactly its bytes: aligned, and the frame's memory is not kept; not `slice`, which is a view
        // of the pool for a Node Buffer)
        return new C(new Uint8Array(b.subarray(blobStart + off, blobStart + off + n)).buffer);
      }
    }
    return v;
  });
}

// the kinds of a record: a message the page posted, an answer to an ask (only `reply` makes one), the page's close
const KIND_MESSAGE = 0, KIND_REPLY = 1, KIND_CLOSE = 2;

/** A post on a closed bridge. `reason`: why it closed. */
export class BridgeClosedError extends Error {
  constructor(reason) { super(`wasmhost bridge: closed (${reason})`); this.name = 'BridgeClosedError'; this.reason = reason; }
}
/** A post that does not fit in the queue (`overflow: 'reject'`), or a frame larger than the whole queue. */
export class BridgeFullError extends Error {
  constructor(message) { super(message); this.name = 'BridgeFullError'; }
}

const errText = (err) => String(err?.message ?? err);
const recordOf = (kind, frame) => { const r = new Uint8Array(1 + frame.length); r[0] = kind; r.set(frame, 1); return r; };

export function makeBridge({ events = null, guard = null, memory = null, onMessage = () => {}, onAsk = null, onClose = () => {},
                             onError = (err) => console.error('wasmhost bridge: onMessage failed:', err),
                             capacity = 1024, maxBytes = 16 << 20, overflow = 'reject' } = {}) {
  if (overflow !== 'reject' && overflow !== 'drop-oldest') throw new Error(`wasmhost bridge: overflow ${overflow}: 'reject' or 'drop-oldest'`);
  if (!(capacity >= 1 && maxBytes >= 1)) throw new Error('wasmhost bridge: capacity and maxBytes must be positive');
  const inbox = [];            // records (u8 kind | frame) for the module, not yet taken
  let queued = 0;              // the bytes of the messages among them (what capacity and maxBytes bound; replies are exempt)
  let counted = 0;             // their number
  let total = 0;               // the bytes of all
  let closed = null;           // why the bridge closed, once it has
  let closing = null;          // the close record, for the module, once the page has closed
  // (posted: records queued; sent: frames of the module; delivered: records taken by the module; dropped, refused:
  // frames of a full queue (overflow), or dropped by a close; strayReplies: replies to an id the module isn't waiting
  // for, or answered already: not queued; errors: onMessage threw)
  const stats = { posted: 0, sent: 0, delivered: 0, dropped: 0, refused: 0, strayReplies: 0, errors: 0 };
  // the ids of the module's asks that the page has not answered yet: a reply to one of them is exempt from the
  // queue's limits, once (the module's asks bound them); any other is refused
  const outstanding = new Set();
  const isReply = (r) => r[0] === KIND_REPLY;

  function enqueue(frame, kind, anySize = false) {
    if (closed !== null) throw new BridgeClosedError(closed);
    if (frame.length > maxBytes && !anySize) { stats.refused++; throw new BridgeFullError(`wasmhost bridge: a frame of ${frame.length} bytes is larger than the queue (maxBytes ${maxBytes})`); }
    if (kind === KIND_MESSAGE) {
      const full = () => counted >= capacity || queued + frame.length > maxBytes;
      if (full() && overflow === 'reject') {
        stats.refused++;
        throw new BridgeFullError(`wasmhost bridge: the queue is full (${counted} frames, ${queued} bytes; capacity ${capacity}, maxBytes ${maxBytes})`);
      }
      // (drop-oldest: the oldest frames that are not replies)
      for (let k = 0; full() && k < inbox.length;) {
        if (isReply(inbox[k])) { k++; continue; }
        const [r] = inbox.splice(k, 1);
        unqueue(r);
        stats.dropped++;
      }
      counted++;
      queued += frame.length;
    }
    inbox.push(recordOf(kind, frame));
    total += frame.length;
    stats.posted++;
    page.notify();
  }
  function unqueue(r) {
    total -= r.length - 1;
    if (!isReply(r)) { counted--; queued -= r.length - 1; }
  }
  // the page's source: the module takes the next record
  function source() {
    if (closing !== null) { const r = closing; closing = null; return r; }
    const r = inbox.shift();
    if (r === undefined) return null;
    unqueue(r);
    stats.delivered++;
    return r;
  }
  function shut(reason, by) {
    if (closed !== null) return false;
    closed = String(reason);
    stats.dropped += inbox.length;
    inbox.length = 0;
    queued = counted = total = 0;
    outstanding.clear();
    if (by === 'page') { closing = recordOf(KIND_CLOSE, encodeFrame(closed)); page.notify(); }
    try { onClose(closed, by); } catch { /* (the page's callback: not the module's error) */ }
    return true;
  }
  function postReply(id, result) {
    if (closed !== null) return;   // (the module gave up its asks when it closed)
    // (an answer that can't be encoded, or is larger than the queue, is the ask's error: the ask must end)
    const failed = (why) => encodeFrame({ bridge_reply: id, error: why });
    let frame;
    try { frame = encodeFrame(result); } catch (err) { frame = failed(`the answer can't be encoded: ${errText(err)}`); }
    // (the error answer is queued whatever its size: small, and the ask must end)
    if (frame.length > maxBytes) frame = failed(`the answer (${frame.length} bytes) is larger than the queue (maxBytes ${maxBytes})`);
    enqueue(frame, KIND_REPLY, true);
  }
  // module -> page: a frame of the module's Page.send (a view of its memory, valid during the call)
  function received(bytes) {
    if (closed !== null) return;   // (the module's frames after the page closed: it learns at its next receive)
    const value = decodeFrame(bytes);
    stats.sent++;
    if (value !== null && typeof value === 'object' && typeof value.bridge_close === 'string') { shut(value.bridge_close, 'module'); return; }
    const ask = value !== null && typeof value === 'object' && Number.isInteger(value.bridge_ask) ? value.bridge_ask : null;
    if (ask !== null) outstanding.add(ask);
    if (ask !== null && onAsk) {
      bridge.reply(ask, new Promise((resolve) => resolve(onAsk(value, bytes))));
      return;
    }
    // (an ask that onMessage threw for is answered with the error: nothing else will answer it)
    try { onMessage(value, bytes); } catch (err) {
      stats.errors++;
      if (ask !== null) bridge.reply(ask, Promise.reject(err));
      try { onError(err, value); } catch { /* (the page's callback) */ }
    }
  }
  const page = makePage({ events, guard, memory, source, onMessage: received,
                          onError: (err) => { stats.errors++; try { onError(err, null); } catch { /* (the page's) */ } } });
  const bridge = {
    stats,
    // the module's imports (`wasm_host_page`), and its memory once it is instantiated
    imports: page.imports,
    bindMemory: (m) => page.bindMemory(m),
    // page -> module: queue `value`; a waiting recv of the module is woken. Throws a BridgeClosedError once
    // closed, a BridgeFullError when it does not fit (overflow 'reject'). A posted message is never an answer to an
    // ask, even with a `bridge_reply` member (the module gets it as data): answers go through `reply`
    post(value) { enqueue(encodeFrame(value), KIND_MESSAGE); },
    // the answer to the module's `Bridge.ask` of id `id`: a value, or a promise of one; a rejection is the ask's
    // error. `true` when it is taken; `false` (nothing queued, stats.strayReplies) for an id the module did not ask,
    // or asked and has been answered (the first reply is the answer), or on a closed bridge
    reply(id, answer) {
      if (!outstanding.delete(id)) { stats.strayReplies++; return false; }
      Promise.resolve(answer).then((value) => postReply(id, { bridge_reply: id, value }),
                                   (err) => postReply(id, { bridge_reply: id, error: errText(err) }));
      return true;
    },
    // records waiting for the module, and their bytes
    pending: () => inbox.length,
    pendingBytes: () => total,
    // what a post may still queue without overflowing
    room: () => ({ frames: Math.max(0, capacity - counted), bytes: Math.max(0, maxBytes - queued) }),
    // whether the module waits in recv
    parked: () => page.waiting(),
    // why it closed, or null while open
    closed: () => closed,
    // the end of the bridge, from the page (it goes away): see the header
    close(reason = 'closed by the page') { shut(reason, 'page'); },
  };
  return bridge;
}
