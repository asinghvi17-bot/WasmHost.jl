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
//     the module directly, again) throws a ReentryError into the module.
//   wasm_host.http_start, http_finish (a module with Julia tasks: `events`), http_batch and
//     http_batch_result: as the Node adapter's (../node/imports.mjs), http_start's optional
//     body too. A start while the module
//     is suspended (a re-entry) throws a ReentryError into the module.
// `fetchImpl` replaces `fetch`; `credentials` is fetch's (default 'omit'). `events`: the
// julia_io events (WasmCodegen's js/julia_io.mjs) of a module with tasks, whose exports are
// called through `promisingExports(inst, { tasks: jt })`: its requests overlap.
import { parseRequest, formatResult, parseBatch } from '../common/fetch.mjs';
import { checkEvents, makeJobs } from '../common/jobs.mjs';
import { makeShimFs, posix } from './fs.mjs';
import { perform } from './http.mjs';
import { jspiGap, oneAtATime, notSuspended } from './jspi.mjs';

const ENOSYS = 52, EINVAL = 28;

export function makeImports({ wasi, spool, fetchImpl, credentials, events } = {}) {
  const gap = jspiGap();
  if (gap) throw new Error(`wasmhost: the browser adapter needs ${gap}`);
  const fs = makeShimFs(wasi);
  if (spool) fs.mkdirp(posix.normalize(spool));
  let memory = null;
  const stats = { requests: 0, started: 0, batches: 0 };
  const jobs = checkEvents(events) && makeJobs(events, stats);
  const exclusive = oneAtATime(wasi, events);
  const check = notSuspended(wasi, events);
  const encoder = new TextEncoder();
  let lastBatch = [];

  function mem() {
    const m = memory ?? wasi.inst?.exports.memory;
    if (!m) throw new Error('wasmhost: no memory (call bindMemory or wasi.initialize first)');
    return m;
  }
  const text = (off, len) => new TextDecoder().decode(new Uint8Array(mem().buffer, off, len));
  // the response text of a request text (never throws)
  async function respond(reqText, signal, body) {
    let result;
    try {
      const req = parseRequest(reqText);
      if (body) req.body = body;
      stats.requests++;
      result = await perform(req, fs, { fetchImpl, credentials, signal });
    } catch (err) {
      result = { code: 2, message: String(err?.message ?? err), url: '', status: 0, headers: [] };
    }
    return formatResult(result);
  }
  // `bytes` into the module's buffer: its length, or -length when it doesn't fit
  function put(bytes, resOff, resCap) {
    if (bytes === undefined) return 0;
    if (bytes.length > resCap) return -bytes.length;
    new Uint8Array(mem().buffer, resOff, bytes.length).set(bytes);   // (a fresh view: memory may have grown)
    return bytes.length;
  }

  async function http_request(reqOff, reqLen, resOff, resCap) {
    const reqText = text(reqOff, reqLen);
    return put(encoder.encode(await respond(reqText)), resOff, resCap);
  }
  function http_start(reqOff, reqLen, bodyOff, bodyLen) {
    check();
    if (!jobs) return -ENOSYS;
    const reqText = text(reqOff, reqLen);
    // (a copy of the body: `bodyLen` < 0 or absent, none)
    const body = typeof bodyLen === 'number' && bodyLen >= 0 ? new Uint8Array(mem().buffer, bodyOff >>> 0, bodyLen).slice() : undefined;
    stats.started++;
    return jobs.start((signal) => respond(reqText, signal, body), (t) => encoder.encode(t));
  }
  const http_finish = (h, resOff, resCap) => { check(); return put(jobs?.result(h), resOff, resCap); };
  async function http_batch(reqOff, reqLen) {
    let texts;
    try { texts = parseBatch(text(reqOff, reqLen)); } catch { return -EINVAL; }
    stats.batches++;
    lastBatch = (await Promise.all(texts.map((t) => respond(t)))).map((t) => encoder.encode(t));
    return lastBatch.length;
  }
  const http_batch_result = (i, resOff, resCap) => { check(); return put(lastBatch[i], resOff, resCap); };

  return { imports: { wasm_host: {
             http_request: new WebAssembly.Suspending((...a) => exclusive(() => http_request(...a))),
             http_start, http_finish, http_batch_result,
             http_batch: new WebAssembly.Suspending((...a) => exclusive(() => http_batch(...a))) } },
           bindMemory(m) { memory = m; }, stats };
}
