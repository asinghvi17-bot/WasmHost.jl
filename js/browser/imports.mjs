// The browser adapter of WasmHost, import transport: the same HTTP requests as `spool.mjs`,
// through WasmHost's import library `wasm_host` instead of the spool directory. Needs a module
// compiled with `Config(import_libraries = ["wasm_host"])` and `WasmHost.transport() = :import`.
//
//   const host = makeImports({ wasi });
//   const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport, ...host.imports });
//   host.bindMemory(inst.exports.memory);
//   wasi.initialize(inst);
//   await promisingExports(inst).main();               // (jspi.mjs: one call at a time)
//
// (Request bodies from and responses into an `IO` still go through files of the spool
// directory, `WASMHOST_SPOOL`, on the shim's filesystem: `makeImports` creates it when given
// `spool`. Decompression always uses the spool directory: give the module
// `wrapWasi(...).wasiImport` too if it decompresses.)
//
//   wasm_host.http_request(req_off i32, req_len i32, res_off i32, res_cap i32) -> i32
//     req: the request text of "wasm-fetch 1" (src/downloads.jl), res: the response text
//     written back; returns its length (or -length when res_cap is too small: nothing
//     written). Suspending (JSPI): the export must be called through WebAssembly.promising
//     (promisingExports). A request while another of the module is in flight (the page called
//     the module directly, again) throws a ReentryError into the re-entrant call and poisons the
//     instance: the suspended call rejects with an InstancePoisonedError instead of resuming, as
//     does every later call (jspi.mjs); recovery is a new instance.
// `fetchImpl` replaces `fetch`; `credentials` is fetch's (default 'omit').
import { parseRequest, formatResult } from '../common/fetch.mjs';
import { makeShimFs, posix } from './fs.mjs';
import { perform } from './http.mjs';
import { jspiGap, oneAtATime } from './jspi.mjs';

export function makeImports({ wasi, spool, fetchImpl, credentials } = {}) {
  const gap = jspiGap();
  if (gap) throw new Error(`wasmhost: the browser adapter needs ${gap}`);
  const fs = makeShimFs(wasi);
  if (spool) fs.mkdirp(posix.normalize(spool));
  let memory = null;
  const stats = { requests: 0 };
  const exclusive = oneAtATime(wasi);
  async function http_request(reqOff, reqLen, resOff, resCap) {
    const mem = memory ?? wasi.inst?.exports.memory;
    if (!mem) throw new Error('wasmhost: no memory (call bindMemory or wasi.initialize first)');
    let result;
    try {
      const req = parseRequest(new TextDecoder().decode(new Uint8Array(mem.buffer, reqOff, reqLen)));
      stats.requests++;
      result = await perform(req, fs, { fetchImpl, credentials });
    } catch (err) {
      result = { code: 2, message: String(err?.message ?? err), url: '', status: 0, headers: [] };
    }
    const bytes = new TextEncoder().encode(formatResult(result));
    if (bytes.length > resCap) return -bytes.length;
    new Uint8Array(mem.buffer, resOff, bytes.length).set(bytes);   // (a fresh view: memory may have grown)
    return bytes.length;
  }
  return { imports: { wasm_host: { http_request: new WebAssembly.Suspending((...a) => exclusive(() => http_request(...a))) } },
           bindMemory(m) { memory = m; }, stats };
}
