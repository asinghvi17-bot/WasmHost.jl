// The browser adapter of WasmHost, spool transport: the host's side of a WASI preview 1 module's
// downloads and decompression, through files of a spool directory (see src/WasmHost.jl), on
// the in-memory filesystem of @bjorn3/browser_wasi_shim. No import of its own: it wraps the
// module's WASI `path_open`, as `../node/spool.mjs` does.
//
// - opening `<spool>/<id>.res` performs the HTTP request of `<spool>/<id>.req` first
//   ("wasm-fetch 1", with `fetch`);
// - opening `<spool>/<id>.dres` decompresses as `<spool>/<id>.dreq` asks ("wasm-decompress 1",
//   with `DecompressionStream`).
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
// module directly, again) throws a ReentryError into the module.
// `fetchImpl` replaces `fetch`; `credentials` is fetch's (default 'omit': the page's cookies
// aren't the program's); `wasiImport` replaces `wasi.wasiImport` (e.g. a wrapped one).
import { parseRequest, formatResult } from '../common/fetch.mjs';
import { parseDecompressRequest, formatDecompressAnswer } from '../common/decompress.mjs';
import { makeShimFs, posix } from './fs.mjs';
import { perform } from './http.mjs';
import { decompressFile, errnoOf } from './decompress.mjs';
import { jspiGap, oneAtATime } from './jspi.mjs';

const KINDS = [
  { kind: 'fetch', res: '.res', req: '.req' },
  { kind: 'decompress', res: '.dres', req: '.dreq' },
];

// The answer for a job that failed before it ran
function failure(kind, err) {
  return kind === 'fetch'
    ? formatResult({ code: 2, message: String(err?.message ?? err), url: '', status: 0, headers: [] })
    : formatDecompressAnswer(errnoOf(err), String(err?.message ?? err));
}

export function wrapWasi(wasi, { spool, fetchImpl, credentials, wasiImport = wasi?.wasiImport } = {}) {
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
  const stats = { requests: 0, decompress: 0 };
  const exclusive = oneAtATime(wasi);

  // { kind, req, res } (guest paths) when the path of this `path_open` is a pending response of
  // the spool, else null
  function pending(dirfd, pathOff, pathLen) {
    const dir = fs.preopenOf(dirfd);
    const mem = memory ?? wasi.inst?.exports.memory;
    if (dir === undefined || !mem) return null;
    const guest = posix.join(dir, decoder.decode(new Uint8Array(mem.buffer, pathOff, pathLen)));
    if (posix.dirname(guest) !== spoolGuest) return null;
    const k = KINDS.find((x) => guest.endsWith(x.res));
    if (k === undefined) return null;
    const req = guest.slice(0, -k.res.length) + k.req;
    if (fs.exists(guest) || !fs.exists(req)) return null;
    return { kind: k.kind, req, res: guest };
  }
  // do the job of a pending response and write the response file; throws only a ReentryError
  // (exclusive's) or when the response can't be written
  async function serve(p) {
    let text;
    try {
      const body = decoder.decode(fs.read(p.req));
      if (p.kind === 'fetch') {
        const req = parseRequest(body);
        stats.requests++;
        text = formatResult(await perform(req, fs, { fetchImpl, credentials }));
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

  const path_open = new WebAssembly.Suspending((...args) => {
    const p = pending(args[0], args[2], args[3]);
    if (p === null) return original(...args);
    return exclusive(() => serve(p)).then(() => original(...args));
  });
  return {
    wasiImport: { ...wasiImport, path_open },
    bindMemory(m) { memory = m; },
    stats,
  };
}
