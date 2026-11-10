// The Node adapter of WasmHost, spool transport: the host's side of a WASI preview 1 module's
// downloads and decompression, through files of a spool directory (see src/WasmHost.jl). No
// import of its own: it wraps the module's WASI `path_open`.
//
// - opening `<spool>/<id>.res` performs the HTTP request of `<spool>/<id>.req` first
//   ("wasm-fetch 1", with `fetch`);
// - opening `<spool>/<id>.dres` decompresses as `<spool>/<id>.dreq` asks ("wasm-decompress 1",
//   with node:zlib);
// - opening `<spool>/<id>.bres` performs the batch of requests of `<spool>/<id>.breq` together
//   ("wasm-fetch-batch 1"), their responses in it;
// - opening `<spool>/<id>.hnd` (with `events`, for a module with Julia tasks) starts the request
//   of `<spool>/<id>.req` without waiting and writes its julia_io handle into it; the handle
//   becomes ready once `<spool>/<id>.res` is written. Without `events` there is no such file:
//   the module waits for each request as a program of one task does.
// - with `bridge` (WasmHost.Bridge, js/common/bridge.mjs): opening `<spool>/<id>.snd` hands the frame of
//   `<spool>/<id>.out` to the page; opening `<spool>/<id>.rcv` starts a receive ("wasm-bridge 1"): its content is
//   a julia_io handle that the page's next `bridge.post` completes (or `0`: the frames are in `<id>.inb` already).
//   Neither suspends the module.
//
//   const host = wrapWasi(wasi.wasiImport, { preopens, spool: '/work/.wasmhost', mode });
//   const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: host.wasiImport });
//   host.bindMemory(inst.exports.memory);
//
// One wrapper serves both: a `WebAssembly.Suspending` can't be wrapped again from JavaScript.
// `preopens` is the `{ guestPath: hostPath }` given to WASI (fds 3, 4, ... in that order).
// `mode`:
//   - 'jspi': `path_open` is a `WebAssembly.Suspending`: the module waits with its stack
//     suspended; exports that download or decompress must be called through
//     `WebAssembly.promising` (Node: --experimental-wasm-jspi where not on by default).
//   - 'sync': the work runs on a worker thread while the main thread blocks in `Atomics.wait`.
// `fetchImpl` replaces `fetch` (jspi mode only; e.g. to refuse all requests). `events`: the
// julia_io events (WasmCodegen's js/julia_io.mjs, `makeJuliaIOEvents()`) a module with tasks
// runs on (jspi mode only): its requests then overlap, each task waiting for its own.

import fs from 'node:fs';
import path from 'node:path';
import { parseRequest, formatResult, parseBatch, formatBatch } from '../common/fetch.mjs';
import { checkEvents, makeJobs } from '../common/jobs.mjs';
import { parseDecompressRequest, formatDecompressAnswer } from '../common/decompress.mjs';
import { makeMapper } from './paths.mjs';
import { perform } from './http.mjs';
import { decompressFile, errnoOf } from './decompress.mjs';
import { attachBridge } from '../common/bridge.mjs';

export { makeMapper, perform, decompressFile };

const KINDS = [
  { kind: 'fetch', res: '.res', req: '.req' },
  { kind: 'decompress', res: '.dres', req: '.dreq' },
  { kind: 'batch', res: '.bres', req: '.breq' },
  { kind: 'start', res: '.hnd', req: '.req' },
  { kind: 'bsend', res: '.snd', req: '.out' },
  { kind: 'brecv', res: '.rcv', req: '.rq' },
];

const fetchFailure = (err) => formatResult({ code: 2, message: String(err?.message ?? err), url: '', status: 0, headers: [] });

// The answer for a job that failed before it ran
function failure(kind, err) {
  return kind === 'decompress' ? formatDecompressAnswer(errnoOf(err), String(err?.message ?? err)) : fetchFailure(err);
}

// The response text of a request (a parsed one, host paths mapped, or the Error of one that
// isn't). Never throws.
async function respond(req, { fetchImpl, signal } = {}) {
  if (req instanceof Error) return fetchFailure(req);
  try { return formatResult(await perform(req, { fetchImpl, signal })); } catch (err) { return fetchFailure(err); }
}

// Do one job (host paths mapped) and write its response file. Never throws.
export async function serve(job, { fetchImpl } = {}) {
  let text;
  try {
    if (job.kind === 'fetch') {
      text = await respond(job.req, { fetchImpl });
    } else if (job.kind === 'batch') {
      text = formatBatch(await Promise.all(job.reqs.map((r) => respond(r, { fetchImpl }))));
    } else {
      const [errno, message] = await decompressFile(job.srcHost, job.dstHost, job.format);
      text = formatDecompressAnswer(errno, message);
    }
  } catch (err) {
    text = failure(job.kind, err);
  }
  fs.writeFileSync(job.resHost, text);
}

export function wrapWasi(wasiImport, { preopens = {}, spool, mode = 'jspi', fetchImpl, events, bridge } = {}) {
  if (!spool) throw new Error('wasmhost: no spool directory');
  const map = makeMapper(preopens);
  const spoolGuest = path.posix.normalize(spool);
  fs.mkdirSync(map.toHost(spoolGuest), { recursive: true });
  let memory = null;
  const decoder = new TextDecoder();
  const original = wasiImport.path_open;
  const stats = { requests: 0, decompress: 0, started: 0, batches: 0 };
  if (events != null && mode !== 'jspi') throw new Error("wasmhost: events (a module with tasks) need mode 'jspi'");
  const jobs = checkEvents(events) && makeJobs(events, stats);
  // (the bridge's module side: this adapter's alone)
  const port = bridge ? attachBridge(bridge) : null;

  // { kind, reqHost, resHost } when the path of this `path_open` is a pending response of the
  // spool, else null
  function pending(dirfd, pathOff, pathLen) {
    const dir = map.preopenOf(dirfd);
    if (dir === undefined || memory === null) return null;
    const guest = path.posix.join(dir, decoder.decode(new Uint8Array(memory.buffer, pathOff, pathLen)));
    if (path.posix.dirname(guest) !== spoolGuest) return null;
    const k = KINDS.find((x) => guest.endsWith(x.res));
    if (k === undefined || (k.kind === 'start' && !jobs) || ((k.kind === 'bsend' || k.kind === 'brecv') && !bridge)) return null;
    const resHost = map.toHost(guest);
    const reqHost = resHost.slice(0, -k.res.length) + k.req;
    if (fs.existsSync(resHost) || !fs.existsSync(reqHost)) return null;
    return { kind: k.kind, reqHost, resHost };
  }
  // a request text parsed, its paths mapped (throws for a bad one)
  function request(text) {
    const req = parseRequest(text);
    req.outputHost = req.output ? map.toHost(req.output) : '';
    req.inputHost = req.input ? map.toHost(req.input) : '';
    stats.requests++;
    return req;
  }
  // the job of a pending response (throws for a bad request)
  function prepare(p) {
    const text = fs.readFileSync(p.reqHost, 'utf8');
    if (p.kind === 'fetch') return { kind: 'fetch', req: request(text), resHost: p.resHost };
    if (p.kind === 'batch') {
      stats.batches++;
      // (a bad request of the batch fails alone)
      const reqs = parseBatch(text).map((t) => { try { return request(t); } catch (err) { return err; } });
      return { kind: 'batch', reqs, resHost: p.resHost };
    }
    const d = parseDecompressRequest(text);
    stats.decompress++;
    return { kind: 'decompress', srcHost: map.toHost(d.src), dstHost: map.toHost(d.dst), format: d.format, resHost: p.resHost };
  }

  // (a module with tasks) start the request of `<id>.req` and write its handle into `<id>.hnd`;
  // `<id>.res` once it is done (unless the module gave it up)
  function start(p) {
    let req;
    try { req = request(fs.readFileSync(p.reqHost, 'utf8')); } catch (err) { req = err; }
    const resHost = p.reqHost.slice(0, -'.req'.length) + '.res';
    stats.started++;
    const h = jobs.start((signal) => respond(req, { fetchImpl, signal }), (text) => { fs.writeFileSync(resHost, text); });
    fs.writeFileSync(p.resHost, String(h));
  }

  // the bridge's two files (no suspension: the module goes on). Throws only when the answer can't be written.
  function bridged(p) {
    const inbHost = p.reqHost.slice(0, -'.rq'.length) + '.inb';
    port.serveFile(p.kind, {
      read: () => new Uint8Array(fs.readFileSync(p.reqHost)),
      answer: (text) => fs.writeFileSync(p.resHost, text),
      writeInbox: (bytes) => fs.writeFileSync(inbHost, bytes),
      removeInbox: () => fs.rmSync(inbHost, { force: true }),
    });
  }

  let path_open;
  if (mode === 'jspi') {
    if (typeof WebAssembly.Suspending !== 'function')
      throw new Error('wasmhost: mode "jspi" needs JavaScript Promise Integration (Node: --experimental-wasm-jspi)');
    path_open = new WebAssembly.Suspending((...args) => {
      const p = pending(args[0], args[2], args[3]);
      if (p === null) return original(...args);
      // (no suspension: the module goes on, the request runs)
      if (p.kind === 'start') { start(p); return original(...args); }
      if (p.kind === 'bsend' || p.kind === 'brecv') { bridged(p); return original(...args); }
      return (async () => {
        let job;
        try { job = prepare(p); } catch (err) { fs.writeFileSync(p.resHost, failure(p.kind, err)); return original(...args); }
        await serve(job, { fetchImpl });
        return original(...args);
      })();
    });
  } else if (mode === 'sync') {
    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);
    let worker = null;
    path_open = (...args) => {
      const p = pending(args[0], args[2], args[3]);
      if (p === null) return original(...args);
      if (p.kind === 'bsend' || p.kind === 'brecv') { bridged(p); return original(...args); }
      let job;
      try { job = prepare(p); } catch (err) { fs.writeFileSync(p.resHost, failure(p.kind, err)); return original(...args); }
      worker ??= workerFor(sab);
      Atomics.store(flag, 0, 0);
      worker.postMessage(job);
      Atomics.wait(flag, 0, 0);
      return original(...args);
    };
  } else {
    throw new Error(`wasmhost: mode ${mode}: 'jspi' or 'sync'`);
  }
  return {
    wasiImport: { ...wasiImport, path_open },
    bindMemory(m) { memory = m; },
    stats,
  };
}

// (sync mode) one worker per adapter, doing the jobs; unref'd so it never keeps the process
// alive
let WorkerCtor = null;
function workerFor(sab) {
  WorkerCtor ??= process.getBuiltinModule('node:worker_threads').Worker;
  const src = `
    const { parentPort, workerData } = require('node:worker_threads');
    const flag = new Int32Array(workerData.sab);
    let mod = null;
    parentPort.on('message', async (job) => {
      mod ??= await import(workerData.self);
      await mod.serve(job);
      Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
    });`;
  const w = new WorkerCtor(src, { eval: true, workerData: { sab, self: import.meta.url } });
  w.unref();
  return w;
}
