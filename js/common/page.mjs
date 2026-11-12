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
export function makePage({ onMessage = () => {}, onError = (err) => console.error('wasm_host_page: onMessage failed:', err), memory = null } = {}) {
  let mem = memory;
  const queue = [];            // posted messages, for the module
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
  const pending = () => (queue.length ? queue[0].length : -1);
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
    imports: { [LIBRARY]: { send, pending, read, pop } },
    bindMemory(m) { mem = m; },
    /** Queue a message for the module (copied now): `Page.receive`/`Page.poll` get it, in order. */
    post(message) { queue.push(ownBytes(message)); },
    /** How many posted messages the module has not received yet. */
    queued: () => queue.length,
    stats,
  };
}
