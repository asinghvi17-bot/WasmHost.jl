// The host's side of WasmHost.Bridge ("wasm-bridge 1", src/bridge.jl): a message channel between the
// module and the page, both ways. No Node or browser API is used here.
//
//   const bridge = makeBridge({ events, onMessage: (value) => ... });   // events: the julia_io events
//   const host = wrapWasi(..., { bridge });                             // the adapter serves the module's side
//   bridge.post({ msg_type: '0', id: obsId, payload: ... });            // page -> module
//
// - Module to page: the module opens `<id>.snd` after writing `<id>.out`; the adapter calls
//   `bridge.send(bytes)`, which decodes the frame and calls `onMessage(value, bytes)`. Synchronous: it never
//   suspends the module.
// - Page to module: `bridge.post(value)` queues a frame. The module's `recv` opens `<id>.rcv` after writing
//   `<id>.rq`; the adapter calls `bridge.startRecv(wait, write)`. If a frame is queued (or the module does not
//   wait) the frames are written at once (`write(bytes)`, the `<id>.inb` file) and the handle is `0`; else an
//   external julia_io handle (`events.external()`) is returned, and made ready, with the frames written first,
//   when the page posts one. So a page's event never calls into the module: it completes the handle of the call in
//   flight (which the module waits for as for a timer), or waits in the queue for the next `recv`.
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
  const header = new TextEncoder().encode(JSON.stringify(value, function (k, v) {
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
  }));
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
        // (a copy: aligned, and the frame's memory is not kept)
        return new C(b.slice(blobStart + off, blobStart + off + n).buffer);
      }
    }
    return v;
  });
}

const EBUSY = 10;   // (WASI errno)

export function makeBridge({ events = null, onMessage = () => {} } = {}) {
  const inbox = [];            // frames (Uint8Array) the page posted, not yet taken by the module
  let waiting = null;          // { h, write } of a pending recv
  const stats = { posted: 0, sent: 0, delivered: 0, parked: 0 };

  function take() {
    const frames = inbox.splice(0);
    let n = 0;
    for (const f of frames) n += 4 + f.length;
    const out = new Uint8Array(n);
    const dv = new DataView(out.buffer);
    let at = 0;
    for (const f of frames) { dv.setUint32(at, f.length, true); out.set(f, at + 4); at += 4 + f.length; }
    stats.delivered += frames.length;
    return out;
  }
  function wake() {
    if (waiting === null || inbox.length === 0) return;
    const w = waiting;
    waiting = null;
    w.write(take());
    events.ready(w.h);
  }
  return {
    stats,
    // page -> module: queue `value`; a pending recv of the module is completed
    post(value) {
      inbox.push(encodeFrame(value));
      stats.posted++;
      wake();
    },
    // frames waiting for the module
    pending: () => inbox.length,
    // whether the module is parked in recv
    parked: () => waiting !== null,
    // module -> page (the adapter calls it for `<id>.snd`)
    send(bytes) {
      stats.sent++;
      onMessage(decodeFrame(bytes), bytes);
    },
    // the adapter calls it for `<id>.rcv`: the handle for `<id>.rcv` (0: `write` was called with the frames)
    // or a negative errno
    startRecv(wait, write) {
      if (inbox.length > 0 || !wait || events === null) { write(take()); return 0; }
      if (waiting !== null) return -EBUSY;
      const h = events.external({ onClose: () => { if (waiting !== null && waiting.h === h) waiting = null; } });
      waiting = { h, write };
      stats.parked++;
      return h;
    },
  };
}
