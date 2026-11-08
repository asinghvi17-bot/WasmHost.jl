// The Node adapter of WasmHost, import transport: the same HTTP requests as `spool.mjs`,
// through WasmHost's import library `wasm_host` instead of the spool directory. Needs a module
// compiled with `Config(import_libraries = ["wasm_host"])` and `WasmHost.transport() = :import`.
//
//   const host = makeImports({ preopens });
//   const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport, ...host.imports });
//   host.bindMemory(inst.exports.memory);
//   await WebAssembly.promising(inst.exports.main)();
//
// A module with Julia tasks (`Config(tasks = :jspi)`) runs on WasmCodegen's julia_io events and
// julia_task (its js/): give the adapter the same `events`, and its requests overlap, each task
// waiting for its own while the others run:
//
//   const events = makeJuliaIOEvents();
//   const host = makeImports({ preopens, events });
//   ... { julia_io: events.imports, ...jt.imports, ...host.imports } ...
//   await jt.call(inst.exports.main);
//
// (Request bodies from and responses into an `IO` still go through files of the spool
// directory, `WASMHOST_SPOOL`: create it before running the module. Decompression always uses
// the spool directory: give the module `wrapWasi(...).wasiImport` too if it decompresses.)
//
//   wasm_host.http_request(req_off i32, req_len i32, res_off i32, res_cap i32) -> i32
//     req: the request text of "wasm-fetch 1" (src/downloads.jl), res: the response text
//     written back; returns its length (or -length when res_cap is too small: nothing
//     written). Suspending (JSPI): the export must be called through WebAssembly.promising.
//   wasm_host.http_start(req_off i32, req_len i32) -> i32
//     Starts the request and returns at once: a julia_io handle (> 0) that becomes ready when
//     the response is there, or -52 (ENOSYS) without `events`. Not suspending. The module
//     closes the handle (julia_io's `close`), which drops the request if it still runs.
//   wasm_host.http_finish(h i32, res_off i32, res_cap i32) -> i32
//     The response text of the started request `h` once it is ready: its length, -length when
//     res_cap is too small (nothing written; kept), 0 when there is none (not ready, unknown).
//   wasm_host.http_batch(req_off i32, req_len i32) -> i32
//     req: a batch of requests ("wasm-fetch-batch 1"), performed together; returns their
//     number once all are done (or -28, EINVAL, for a malformed batch). Suspending.
//   wasm_host.http_batch_result(i i32, res_off i32, res_cap i32) -> i32
//     The response text of the i-th request (from 0) of the last batch, as http_finish.
import { parseRequest, formatResult, parseBatch } from '../common/fetch.mjs';
import { checkEvents, makeJobs } from '../common/jobs.mjs';
import { makeMapper } from './paths.mjs';
import { perform } from './http.mjs';

const ENOSYS = 52, EINVAL = 28;

export function makeImports({ preopens = {}, fetchImpl, events } = {}) {
  const map = makeMapper(preopens);
  let memory = null;
  const stats = { requests: 0, started: 0, batches: 0 };
  const jobs = checkEvents(events) && makeJobs(events, stats);
  const encoder = new TextEncoder();
  let lastBatch = [];

  const text = (off, len) => new TextDecoder().decode(new Uint8Array(memory.buffer, off, len));
  // the response text of a request text (never throws)
  async function respond(reqText, signal) {
    let result;
    try {
      const req = parseRequest(reqText);
      req.outputHost = req.output ? map.toHost(req.output) : '';
      req.inputHost = req.input ? map.toHost(req.input) : '';
      stats.requests++;
      result = await perform(req, { fetchImpl, signal });
    } catch (err) {
      result = { code: 2, message: String(err?.message ?? err), url: '', status: 0, headers: [] };
    }
    return formatResult(result);
  }
  // `bytes` into the module's buffer: its length, or -length when it doesn't fit
  function put(bytes, resOff, resCap) {
    if (bytes === undefined) return 0;
    if (bytes.length > resCap) return -bytes.length;
    new Uint8Array(memory.buffer, resOff, bytes.length).set(bytes);   // (a fresh view: memory may have grown)
    return bytes.length;
  }

  async function http_request(reqOff, reqLen, resOff, resCap) {
    return put(encoder.encode(await respond(text(reqOff, reqLen))), resOff, resCap);
  }
  function http_start(reqOff, reqLen) {
    if (!jobs) return -ENOSYS;
    const reqText = text(reqOff, reqLen);
    stats.started++;
    return jobs.start((signal) => respond(reqText, signal), (t) => encoder.encode(t));
  }
  const http_finish = (h, resOff, resCap) => put(jobs?.result(h), resOff, resCap);
  async function http_batch(reqOff, reqLen) {
    let texts;
    try { texts = parseBatch(text(reqOff, reqLen)); } catch { return -EINVAL; }
    stats.batches++;
    lastBatch = (await Promise.all(texts.map((t) => respond(t)))).map((t) => encoder.encode(t));
    return lastBatch.length;
  }
  const http_batch_result = (i, resOff, resCap) => put(lastBatch[i], resOff, resCap);

  return { imports: { wasm_host: { http_request: new WebAssembly.Suspending(http_request), http_start, http_finish,
                                   http_batch: new WebAssembly.Suspending(http_batch), http_batch_result } },
           bindMemory(m) { memory = m; }, stats };
}
