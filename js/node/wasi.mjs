// Engine-neutral use of a `node:wasi` instance: Node's and Bun's `node:wasi` differ.
//
// | | Node (24+) | Bun (1.x) |
// |---|---|---|
// | `wasiImport` | yes | yes |
// | `getImportObject()` | yes | no |
// | `initialize(instance)` | yes | no (`setMemory(memory)`, then the module's `_initialize`) |
//
//   const inst = await WebAssembly.instantiate(mod, { ...wasiImportObject(wasi), ... });
//   wasiInitialize(wasi, inst);

/** The JavaScript runtime: `'bun'`, `'deno'`, `'node'` or `'other'`. */
export const runtime = typeof globalThis.Bun !== 'undefined' ? 'bun' :
  typeof globalThis.Deno !== 'undefined' ? 'deno' :
  typeof globalThis.process?.versions?.node === 'string' ? 'node' : 'other';

/** `{ wasi_snapshot_preview1: … }` of a WASI instance: `getImportObject()` where it exists. */
export function wasiImportObject(wasi) {
  if (typeof wasi.getImportObject === 'function') return wasi.getImportObject();
  if (wasi.wasiImport) return { wasi_snapshot_preview1: wasi.wasiImport };
  throw new Error('wasiImportObject: this WASI instance has neither getImportObject() nor wasiImport');
}

/** Initializes a reactor for its WASI instance, as node:wasi's `initialize` does (memory, then `_initialize`). */
export function wasiInitialize(wasi, instance) {
  if (typeof wasi.initialize === 'function') return wasi.initialize(instance);
  const { memory, _initialize, _start } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error('wasiInitialize: the instance exports no memory');
  if (_start) throw new Error('wasiInitialize: the instance exports _start (a command, not a reactor)');
  if (typeof wasi.setMemory !== 'function') throw new Error('wasiInitialize: this WASI instance has neither initialize() nor setMemory()');
  wasi.setMemory(memory);
  _initialize?.();
}

/** Why this engine can't run a module whose imports suspend (JSPI), or null if it can. */
export function jspiGap() {
  if (typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function') return null;
  const engine = runtime === 'bun' ? `Bun ${globalThis.Bun.version} (JavaScriptCore)` :
    runtime === 'node' ? `Node ${process.version} (V8 ${process.versions.v8}; needs Node 24+)` : 'this engine';
  return `JSPI (WebAssembly.Suspending/promising): not in ${engine}`;
}
