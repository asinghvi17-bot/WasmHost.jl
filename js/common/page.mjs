// WasmHost's page messages (`WasmHost.Page`, src/page.jl): the host's side of the import library
// `wasm_host_page`. No Node or browser API is used here: it needs only the module's memory.
//
//   const page = makePage({ onMessage: (bytes) => deliver(bytes.slice()) });
//   const inst = await WebAssembly.instantiate(mod, { ...otherImports, ...page.imports });
//   page.bindMemory(inst.exports.memory);
//   page.post(new TextEncoder().encode('hello'));   // for the module's Page.receive / Page.poll
//
//   wasm_host_page.send(off i32, len i32)             the bytes of a message
//   wasm_host_page.pending() -> i32                    the length of the next posted message, or -1
//   wasm_host_page.read(off i32, start i32, n i32)     copy bytes start .. start+n-1 of it to off
//   wasm_host_page.pop()                               that message is done
//   wasm_host_page.wait() -> i32                       0: a message is pending; else a julia_io handle, made ready
//                                                      when one is (-1: no `events`; -2: one waits already)
//
// `onMessage(bytes)` is called once per message the module sends, with a view of the module's
// memory, valid only until `onMessage` returns: the module's next send writes over it (also one
// made by code that `onMessage` calls in the module), and growing the memory detaches it. Copy it
// (`bytes.slice()`) to keep it.
//
// An exception of `onMessage` is not thrown into the module: it is given to `onError(error, bytes)`
// (by default, console.error) and counted in `stats.errors`, and `Page.send` returns as usual. A
// JavaScript exception would unwind the module's frames without running its `finally` blocks
// (WasmCodegen catches only Julia's exceptions), which would leave the staging area allocated.
//
// Waiting (`Page.wait_message`, a module with Julia tasks on julia_io): give `events` (WasmCodegen's
// js/julia_io.mjs `makeJuliaIOEvents()`, the module's julia_io imports). A `wait` with nothing pending
// returns an external handle, and `post` (or `notify`) makes it ready: the page's message completes a
// handle of the call in flight, nothing calls into the module.
//
// Two hooks for a layer above (WasmHost.Bridge, js/common/bridge.mjs):
// - `source()`: where the messages come from when nothing posted is queued: the next message (a
//   Uint8Array, kept as it is), or null. It is called when the module looks at the next message, so
//   a layer keeps its own queue (and its own limits) and hands it over one message at a time. Call
//   `notify()` when it has one again (a waiting module is woken).
// - `guard()`: called first in every import; it may throw (a browser adapter's re-entry check, which
//   then poisons the instance: js/browser/jspi.mjs `notSuspended`).

export const LIBRARY = 'wasm_host_page';

const encoder = new TextEncoder();

// a copy of a posted message's bytes: a Uint8Array (or any ArrayBuffer view), an ArrayBuffer or a string (UTF-8)
function ownBytes(message) {
  if (typeof message === 'string') return encoder.encode(message);
  if (message instanceof ArrayBuffer) return new Uint8Array(message.slice(0));
  if (ArrayBuffer.isView(message)) return new Uint8Array(message.buffer, message.byteOffset, message.byteLength).slice();
  throw new TypeError('wasm_host_page: a message is a Uint8Array, an ArrayBuffer or a string');
}

/**
 * The imports of `wasm_host_page` and the host's side of the messages:
 * `{ imports, bindMemory(memory), post(message), queued(), stats }`.
 * `memory` (or `bindMemory` once the instance exists) is the module's exported `memory`.
 * `onError(error, bytes)` gets an exception of `onMessage` (see above).
 */
export function makePage({ onMessage = () => {}, onError = (err) => console.error('wasm_host_page: onMessage failed:', err), memory = null,
                          events = null, source = null, guard = null } = {}) {
  let mem = memory;
  const queue = [];            // posted messages, for the module
  let parked = 0;              // the handle of the module's wait, or 0
  const stats = { sent: 0, sentBytes: 0, received: 0, receivedBytes: 0, errors: 0 };
  const view = (off, len) => {
    if (!mem) throw new Error('wasm_host_page: no memory (page.bindMemory(instance.exports.memory))');
    return new Uint8Array(mem.buffer, off >>> 0, len >>> 0);   // (a fresh view: the memory may have grown)
  };
  function send(off, len) {
    const message = view(off, len);
    stats.sent++; stats.sentBytes += message.length;
    try { onMessage(message); } catch (err) { stats.errors++; onError(err, message); }
  }
  // the next message: the first posted one, or else the source's
  function front() {
    if (!queue.length && source) { const m = source(); if (m != null) queue.push(m); }
    return queue.length ? queue[0] : null;
  }
  const pending = () => front()?.length ?? -1;
  function wait() {
    if (front() !== null) return 0;
    if (!events) return -1;
    if (parked) return -2;
    const h = events.external({ onClose: () => { if (parked === h) parked = 0; }, onCancel: () => { if (parked === h) parked = 0; } });
    parked = h;
    return h;
  }
  function notify() {
    if (!parked || front() === null) return;
    const h = parked;
    parked = 0;
    events.ready(h);
  }
  const guarded = (f) => (guard ? (...args) => { guard(); return f(...args); } : f);
  function read(off, start, n) {
    if (!queue.length) throw new Error('wasm_host_page.read: no message is pending');
    const s = start >>> 0, k = n >>> 0;
    if (s + k > queue[0].length) throw new RangeError('wasm_host_page.read: past the end of the message');
    view(off, k).set(queue[0].subarray(s, s + k));
  }
  function pop() {
    const m = queue.shift();
    if (m === undefined) throw new Error('wasm_host_page.pop: no message is pending');
    stats.received++; stats.receivedBytes += m.length;
  }
  return {
    imports: { [LIBRARY]: Object.fromEntries(Object.entries({ send, pending, read, pop, wait }).map(([k, f]) => [k, guarded(f)])) },
    bindMemory(m) { mem = m; },
    /** Queue a message for the module (copied now): `Page.receive`/`Page.poll` get it, in order. */
    post(message) { queue.push(ownBytes(message)); notify(); },
    /** The source has a message again: a waiting module is woken. */
    notify,
    /** Whether the module waits (`Page.wait_message`). */
    waiting: () => parked !== 0,
    /** How many posted messages the module has not received yet. */
    queued: () => queue.length,
    stats,
  };
}
