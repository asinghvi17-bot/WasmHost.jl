// The host's side of WasmHost.Bridge ("wasm-bridge 1", src/bridge.jl; docs/bridge.md): a message channel between
// the module and the page, both ways. No Node or browser API is used here.
//
//   const bridge = makeBridge({ events, onMessage: (value) => ..., onAsk: async (request) => answer });
//   const host = wrapWasi(..., { events, bridge });                     // the adapter serves the module's side
//   bridge.post({ msg_type: '0', id: obsId, payload: ... });            // page -> module
//   bridge.close('page closed');                                        // the end: the module's recv and asks fail
//
// - Module to page: the module opens `<id>.snd` after writing `<id>.out`; the adapter calls
//   `bridge.send(bytes)`, which decodes the frame and calls `onMessage(value, bytes)` (or `onAsk`, for a request of
//   `Bridge.ask`). Synchronous: it never suspends the module. What `onMessage` throws is the module's `send` error.
// - Page to module: `bridge.post(value)` queues a frame. The module's `recv` opens `<id>.rcv` after writing
//   `<id>.rq`; the adapter calls `bridge.startRecv(wait, write)`. If a frame is queued (or the module does not
//   wait) the frames are written at once (`write(bytes)`, the `<id>.inb` file) and the handle is `0`; else an
//   external julia_io handle (`events.external()`) is returned, and made ready, with the frames written first,
//   when the page posts one. So a page's event never calls into the module: it completes the handle of the call in
//   flight (which the module waits for as for a timer), or waits in the queue for the next `recv`.
// - Frames leave the queue only once they are written: a `write` that throws leaves them queued, and the module's
//   receive fails (`startRecv` answers -EIO; a parked receive's handle is made ready with the error as its message
//   and no `<id>.inb`): no receive is stranded, and the next receive gets the frames (unless the module gives up:
//   `Bridge.serve` fails on it and closes the bridge, which drops them).
// - The queue is bounded (`capacity` frames, `maxBytes` bytes). When it is full, `overflow: 'reject'` (the default)
//   makes `post` throw a BridgeFullError and queue nothing (the page's backpressure: `room()` says how much fits);
//   `'drop-oldest'` drops the oldest frames to make room (for events that only matter as the latest state). The
//   first reply to each outstanding ask of the module is always queued (the module's asks bound them); `reply`
//   refuses (`false`) any other: an id not asked, or answered already. One receive takes at most `chunkBytes`
//   of frames (at least one frame); the rest is there at once for the next.
// - Closing: `bridge.close(reason)` (the page goes away) drops the queue, fails a parked receive and every later one
//   (the module's `recv` throws a BridgeClosedError, its pending asks too), and makes `post` throw a
//   BridgeClosedError. The module closes it too (`Bridge.close`, or its `serve` ending): `onClose(reason, 'module')`.
//
// A frame is `u32le header_length | header (JSON) | blobs`: typed arrays are in the blobs, 8-byte aligned, and the
// JSON holds `{"$b": [offset, bytes, "f32"]}` in their place; decoded they are typed arrays again. `NaN` and
// `Infinity` are `null` (JSON has no such numbers).

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

const EBUSY = 10, EIO = 29, EPIPE = 64;   // (WASI errnos)
// the kinds of an inbox record: a message the page posted, an answer to an ask (only `reply` makes one)
const KIND_MESSAGE = 0, KIND_REPLY = 1;
// the message of a parked receive's handle when the bridge closed (src/bridge.jl reads it: no `<id>.inb`)
export const CLOSED_PREFIX = 'wasm-bridge closed: ';

/** A post, or a receive of the module, on a closed bridge. `reason`: why it closed. */
export class BridgeClosedError extends Error {
  constructor(reason) { super(`wasmhost bridge: closed (${reason})`); this.name = 'BridgeClosedError'; this.reason = reason; }
}
/** A post that does not fit in the queue (`overflow: 'reject'`), or a frame larger than the whole queue. */
export class BridgeFullError extends Error {
  constructor(message) { super(message); this.name = 'BridgeFullError'; }
}

const errText = (err) => String(err?.message ?? err);

export function makeBridge({ events = null, onMessage = () => {}, onAsk = null, onClose = () => {},
                             capacity = 1024, maxBytes = 16 << 20, chunkBytes = 1 << 20, overflow = 'reject' } = {}) {
  if (overflow !== 'reject' && overflow !== 'drop-oldest') throw new Error(`wasmhost bridge: overflow ${overflow}: 'reject' or 'drop-oldest'`);
  if (!(capacity >= 1 && maxBytes >= 1 && chunkBytes >= 1)) throw new Error('wasmhost bridge: capacity, maxBytes and chunkBytes must be positive');
  const inbox = [];            // frames (Uint8Array) the page posted, not yet taken by the module
  const replies = new WeakSet(); // those of them that answer the module's asks: never dropped, not counted
  let queued = 0;              // the bytes of the others (what capacity and maxBytes bound)
  let counted = 0;             // their number
  let total = 0;               // the bytes of all
  let waiting = null;          // { h, write } of a pending recv
  let closed = null;           // why the bridge closed, once it has
  // (posted: frames queued; sent: frames of the module; delivered: frames taken by the module, in `receives` writes;
  // parked: receives that waited; dropped, refused: frames of a full queue (overflow), or dropped by a close)
  // (strayReplies: replies to an id the module isn't waiting for, or answered already: not queued)
  const stats = { posted: 0, sent: 0, delivered: 0, receives: 0, parked: 0, dropped: 0, refused: 0, writeErrors: 0, strayReplies: 0 };
  // the ids of the module's asks that the page has not answered yet: a reply to one of them is exempt from the
  // queue's limits, once (the module's asks bound them); any other is refused
  const outstanding = new Set();

  function enqueue(frame, isReply, anySize = false) {
    if (closed !== null) throw new BridgeClosedError(closed);
    if (frame.length > maxBytes && !anySize) { stats.refused++; throw new BridgeFullError(`wasmhost bridge: a frame of ${frame.length} bytes is larger than the queue (maxBytes ${maxBytes})`); }
    if (isReply) replies.add(frame);
    else {
      const full = () => counted >= capacity || queued + frame.length > maxBytes;
      if (full() && overflow === 'reject') {
        stats.refused++;
        throw new BridgeFullError(`wasmhost bridge: the queue is full (${counted} frames, ${queued} bytes; capacity ${capacity}, maxBytes ${maxBytes})`);
      }
      // (drop-oldest: the oldest frames that are not replies)
      for (let k = 0; full() && k < inbox.length;) {
        if (replies.has(inbox[k])) { k++; continue; }
        const [f] = inbox.splice(k, 1);
        unqueue(f);
        stats.dropped++;
      }
      counted++;
      queued += frame.length;
    }
    inbox.push(frame);
    total += frame.length;
    stats.posted++;
    wake();
  }
  function unqueue(f) {
    total -= f.length;
    if (!replies.has(f)) { counted--; queued -= f.length; }
  }
  // write the next chunk of frames (`u32le length | frame`, repeated; at most chunkBytes, at least one frame), and
  // take them off the queue once `write` returned (it may throw: they stay queued)
  // (a record is `u32le length | u8 kind | frame`: KIND_REPLY only for what `reply` queued, so nothing the page
  // posts can answer an ask, whatever its JSON)
  function deliver(write) {
    let n = 0, size = 0;
    while (n < inbox.length && (n === 0 || size + 5 + inbox[n].length <= chunkBytes)) size += 5 + inbox[n++].length;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    let at = 0;
    for (let k = 0; k < n; k++) {
      const f = inbox[k];
      dv.setUint32(at, f.length, true);
      out[at + 4] = replies.has(f) ? KIND_REPLY : KIND_MESSAGE;
      out.set(f, at + 5);
      at += 5 + f.length;
    }
    write(out);
    for (let k = 0; k < n; k++) unqueue(inbox[k]);
    inbox.splice(0, n);
    stats.delivered += n;
    stats.receives++;
  }
  function wake() {
    if (waiting === null || inbox.length === 0) return;
    const w = waiting;
    waiting = null;
    try { deliver(w.write); } catch (err) {
      // (the frames stay queued; the module's recv fails with this message instead of waiting for ever)
      stats.writeErrors++;
      events.ready(w.h, `wasm-bridge: the frames could not be written: ${errText(err)}`);
      return;
    }
    events.ready(w.h);
  }
  function shut(reason, by) {
    if (closed !== null) return false;
    closed = String(reason);
    stats.dropped += inbox.length;
    inbox.length = 0;
    queued = counted = total = 0;
    outstanding.clear();
    if (waiting !== null) { const w = waiting; waiting = null; events.ready(w.h, CLOSED_PREFIX + closed); }
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
    enqueue(frame, true, true);
  }
  const bridge = {
    stats,
    // page -> module: queue `value`; a pending recv of the module is completed. Throws a BridgeClosedError once
    // closed, a BridgeFullError when it does not fit (overflow 'reject'). A posted message is never an answer to an
    // ask, even with a `bridge_reply` member (the module gets it as data): answers go through `reply`
    post(value) { enqueue(encodeFrame(value), false); },
    // the answer to the module's `Bridge.ask` of id `id`: a value, or a promise of one; a rejection is the ask's
    // error. `true` when it is taken; `false` (nothing queued, stats.strayReplies) for an id the module did not ask,
    // or asked and has been answered (the first reply is the answer), or on a closed bridge
    reply(id, answer) {
      if (!outstanding.delete(id)) { stats.strayReplies++; return false; }
      Promise.resolve(answer).then((value) => postReply(id, { bridge_reply: id, value }),
                                   (err) => postReply(id, { bridge_reply: id, error: errText(err) }));
      return true;
    },
    // frames waiting for the module, and their bytes
    pending: () => inbox.length,
    pendingBytes: () => total,
    // what a post may still queue without overflowing
    room: () => ({ frames: Math.max(0, capacity - counted), bytes: Math.max(0, maxBytes - queued) }),
    // whether the module is parked in recv
    parked: () => waiting !== null,
    // why it closed, or null while open
    closed: () => closed,
    // the end of the bridge, from the page (it goes away): see the header
    close(reason = 'closed by the page') { shut(reason, 'page'); },
    // module -> page (the adapter calls it for `<id>.snd`)
    send(bytes) {
      if (closed !== null) throw new BridgeClosedError(closed);
      const value = decodeFrame(bytes);
      stats.sent++;
      if (value !== null && typeof value === 'object' && typeof value.bridge_close === 'string') { shut(value.bridge_close, 'module'); return; }
      const ask = value !== null && typeof value === 'object' && Number.isInteger(value.bridge_ask) ? value.bridge_ask : null;
      if (ask !== null) outstanding.add(ask);
      if (ask !== null && onAsk) {
        bridge.reply(ask, new Promise((resolve) => resolve(onAsk(value, bytes))));
        return;
      }
      // (an ask that onMessage threw for is the module's send error: its ask ends, nothing will answer it)
      try { onMessage(value, bytes); } catch (err) { if (ask !== null) outstanding.delete(ask); throw err; }
    },
    // the adapter calls it for `<id>.rcv`: the handle for `<id>.rcv` (0: `write` was called with the frames) or a
    // negative errno (EPIPE: closed; EBUSY: a receive is pending; EIO: `write` threw, the frames stay queued)
    startRecv(wait, write) {
      if (closed !== null) return -EPIPE;
      if (waiting !== null) return -EBUSY;
      if (inbox.length > 0 || !wait || events === null) {
        try { deliver(write); } catch { stats.writeErrors++; return -EIO; }
        return 0;
      }
      const h = events.external({
        onClose: () => { if (waiting !== null && waiting.h === h) waiting = null; },
        onCancel: () => { if (waiting !== null && waiting.h === h) waiting = null; },
      });
      waiting = { h, write };
      stats.parked++;
      return h;
    },
  };
  return bridge;
}

// The adapters' part (Node's and the browser's spool.mjs): the module opened `<id>.snd` (kind 'bsend') or `<id>.rcv`
// ('brecv'). `io`: `read()` the request file (`<id>.out` or `<id>.rq`), `answer(text)` the response file, `writeInbox`
// and `removeInbox` the frames file `<id>.inb`. Throws only when the answer can't be written.
export function serveBridgeFile(bridge, kind, { read, answer, writeInbox, removeInbox }) {
  if (kind === 'bsend') {
    let ans = 'ok';
    try { bridge.send(read()); } catch (err) {
      ans = err instanceof BridgeClosedError ? `closed: ${err.reason}` : `error: ${errText(err)}`;
    }
    answer(ans);
    return;
  }
  let wait = false;
  try { wait = new TextDecoder().decode(read()) === 'wait'; } catch { /* (a poll) */ }
  const h = bridge.startRecv(wait, (bytes) => {
    // (no partial inbox for the module to read: it is removed when the write fails)
    try { writeInbox(bytes); } catch (err) { try { removeInbox(); } catch { /* (gone) */ } throw err; }
  });
  // (a closed bridge: the reason on a line of its own)
  answer(h === -EPIPE ? `${h}\n${bridge.closed()}` : String(h));
}
