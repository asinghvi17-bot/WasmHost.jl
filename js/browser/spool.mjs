// The browser adapter of WasmHost, spool transport: the host's side of a WASI preview 1 module's
// downloads and decompression, through files of a spool directory (see src/WasmHost.jl), on
// the in-memory filesystem of @bjorn3/browser_wasi_shim. No import of its own: it wraps the
// module's WASI `path_open`, as `../node/spool.mjs` does.
//
// - opening `<spool>/<id>.res` performs the HTTP request of `<spool>/<id>.req` first
//   ("wasm-fetch 1", with `fetch`);
// - opening `<spool>/<id>.dres` decompresses as `<spool>/<id>.dreq` asks ("wasm-decompress 1",
//   with `DecompressionStream`);
// - opening `<spool>/<id>.bres` performs the batch of requests of `<spool>/<id>.breq` together
//   ("wasm-fetch-batch 1");
// - opening `<spool>/<id>.hnd` (with `events`: a module with Julia tasks) starts the request of
//   `<spool>/<id>.req` without suspending and writes its julia_io handle into it; the handle
//   becomes ready once `<spool>/<id>.res` is written.
//
//   const wasi = new WASI(args, ['WASMHOST_SPOOL=/work/.wasmhost', ...], [stdin, stdout, stderr,
//                         new PreopenDirectory('/work', new Map())]);
//   const host = wrapWasi(wasi, { spool: '/work/.wasmhost' });
//   const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: host.wasiImport });
//   host.bindMemory(inst.exports.memory);
//   wasi.initialize(inst);
//   const exports = promisingExports(inst);           // (jspi.mjs: one call at a time)
//   await exports.main();
//
// Waiting is JSPI only: `path_open` is a `WebAssembly.Suspending`, and exports that download or
// decompress must be called through `WebAssembly.promising`: call them all through
// `promisingExports(inst)`, which also keeps to one call at a time per module (Julia's runtime
// isn't re-entrant). (A page's main thread can't block, so Node's 'sync' mode has no browser
// counterpart.) A job that starts while another of the module is suspended (the page called the
// module directly, again) throws a ReentryError into the re-entrant call and poisons the
// instance: the suspended call rejects with an InstancePoisonedError instead of resuming, as does
// every later call (jspi.mjs); recovery is a new instance.
// `fetchImpl` replaces `fetch`; `credentials` is fetch's (default 'omit': the page's cookies
// aren't the program's); `wasiImport` replaces `wasi.wasiImport` (e.g. a wrapped one); `events`:
// the julia_io events (WasmCodegen's js/julia_io.mjs) of a module with tasks, whose exports are
// called through `promisingExports(inst, { tasks: jt })`: its requests overlap. A start while
// the module is suspended (a re-entry) throws a ReentryError into the module and poisons the
// instance in the same way.
import { parseRequest, formatResult, parseBatch, formatBatch } from '../common/fetch.mjs';
import { checkEvents, makeJobs } from '../common/jobs.mjs';
import { parseDecompressRequest, formatDecompressAnswer } from '../common/decompress.mjs';
import { makeShimFs, posix } from './fs.mjs';
import { perform } from './http.mjs';
import { decompressFile, errnoOf } from './decompress.mjs';
import { jspiGap, oneAtATime, notSuspended } from './jspi.mjs';

const KINDS = [
  { kind: 'fetch', res: '.res', req: '.req' },
  { kind: 'decompress', res: '.dres', req: '.dreq' },
  { kind: 'batch', res: '.bres', req: '.breq' },
  { kind: 'start', res: '.hnd', req: '.req' },
];

const fetchFailure = (err) => formatResult({ code: 2, message: String(err?.message ?? err), url: '', status: 0, headers: [] });

// The answer for a job that failed before it ran
function failure(kind, err) {
  return kind === 'decompress' ? formatDecompressAnswer(errnoOf(err), String(err?.message ?? err)) : fetchFailure(err);
}

export function wrapWasi(wasi, { spool, fetchImpl, credentials, wasiImport = wasi?.wasiImport, events } = {}) {
  if (!spool) throw new Error('wasmhost: no spool directory');
  const gap = jspiGap();
  if (gap) throw new Error(`wasmhost: the browser adapter needs ${gap}`);
  const fs = makeShimFs(wasi);
  const spoolGuest = posix.normalize(spool);
  fs.mkdirp(spoolGuest);
  let memory = null;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const original = wasiImport.path_open;
  const stats = { requests: 0, decompress: 0, started: 0, batches: 0 };
  const jobs = checkEvents(events) && makeJobs(events, stats);
  const exclusive = oneAtATime(wasi, events);
  const check = notSuspended(wasi, events);

  // { kind, req, res } (guest paths) when the path of this `path_open` is a pending response of
  // the spool, else null
  function pending(dirfd, pathOff, pathLen) {
    const dir = fs.preopenOf(dirfd);
    const mem = memory ?? wasi.inst?.exports.memory;
    if (dir === undefined || !mem) return null;
    const guest = posix.join(dir, decoder.decode(new Uint8Array(mem.buffer, pathOff, pathLen)));
    if (posix.dirname(guest) !== spoolGuest) return null;
    const k = KINDS.find((x) => guest.endsWith(x.res));
    if (k === undefined || (k.kind === 'start' && !jobs)) return null;
    const req = guest.slice(0, -k.res.length) + k.req;
    if (fs.exists(guest) || !fs.exists(req)) return null;
    return { kind: k.kind, req, res: guest };
  }
  // the response text of a request text (never throws)
  async function respond(body, signal) {
    try {
      const req = parseRequest(body);
      stats.requests++;
      return formatResult(await perform(req, fs, { fetchImpl, credentials, signal }));
    } catch (err) {
      return fetchFailure(err);
    }
  }
  // do the job of a pending response and write the response file; throws only a ReentryError
  // (exclusive's) or when the response can't be written
  async function serve(p) {
    let text;
    try {
      const body = decoder.decode(fs.read(p.req));
      if (p.kind === 'fetch') {
        text = await respond(body);
      } else if (p.kind === 'batch') {
        stats.batches++;
        text = formatBatch(await Promise.all(parseBatch(body).map((t) => respond(t))));
      } else {
        const d = parseDecompressRequest(body);
        stats.decompress++;
        const [errno, message] = await decompressFile(fs, d.src, d.dst, d.format);
        text = formatDecompressAnswer(errno, message);
      }
    } catch (err) {
      text = failure(p.kind, err);
    }
    fs.write(p.res, encoder.encode(text));
  }

  // (a module with tasks) start the request of `<id>.req` and write its handle into `<id>.hnd`;
  // `<id>.res` once it is done (unless the module gave it up)
  function start(p) {
    check();
    let body;
    try { body = decoder.decode(fs.read(p.req)); } catch (err) { body = err; }
    const res = p.req.slice(0, -'.req'.length) + '.res';
    stats.started++;
    const h = jobs.start((signal) => body instanceof Error ? fetchFailure(body) : respond(body, signal),
                         (text) => { fs.write(res, encoder.encode(text)); });
    fs.write(p.res, encoder.encode(String(h)));
  }

  const path_open = new WebAssembly.Suspending((...args) => {
    const p = pending(args[0], args[2], args[3]);
    if (p === null) return original(...args);
    // (no suspension: the module goes on, the request runs)
    if (p.kind === 'start') { start(p); return original(...args); }
    return exclusive(() => serve(p)).then(() => original(...args));
  });
  return {
    wasiImport: { ...wasiImport, path_open },
    bindMemory(m) { memory = m; },
    stats,
  };
}
