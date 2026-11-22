// The browser adapter of WasmHost, import transport: WasmHost's import library `wasm_host`
// (`Config(import_libraries = ["wasm_host"])`, `WasmHost.transport() = :import`), on a WASI
// instance of @bjorn3/browser_wasi_shim (tested: 0.4.2), whose in-memory files hold the bodies.
//
//   const host = makeImports({ wasi });
//   const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport, ...host.imports });
//   wasi.initialize(inst);
//   await promisingExports(inst).main();               // (jspi.mjs: one call at a time)
//
// Request bodies from and responses into an `IO` go through files of the spool directory
// (`WASMHOST_SPOOL`): create it in the shim's preopen before running the module.
//
//   wasm_host.http_request(req_off i32, req_len i32, res_off i32, res_cap i32) -> i32
//     req: the request text of "wasm-fetch 1" (src/downloads.jl), res: the response text
//     written back; returns its length (or -length when res_cap is too small: nothing
//     written). Suspending (JSPI), guarded (jspi.mjs): a request while another of the module
//     is in flight poisons the instance.
//
// `fetchImpl` replaces `fetch`; `credentials` is fetch's: 'omit' by default, so that the page's
// cookies and HTTP authentication don't go with the program's requests.
import { CURLE, parseRequest, formatResult } from '../common/fetch.mjs';
import { jspiGap, guarded } from './jspi.mjs';

export function makeImports({ wasi, fetchImpl = (...a) => globalThis.fetch(...a), credentials = 'omit' } = {}) {
  const gap = jspiGap();
  if (gap) throw new Error(`wasmhost: the browser adapter needs ${gap}`);
  if (!Array.isArray(wasi?.fds)) throw new Error('wasmhost: not a WASI instance of @bjorn3/browser_wasi_shim');
  const files = shimFiles(wasi);
  const stats = { requests: 0 };
  async function http_request(reqOff, reqLen, resOff, resCap) {
    const memory = wasi.inst.exports.memory;
    let result;
    try {
      const req = parseRequest(new TextDecoder().decode(new Uint8Array(memory.buffer, reqOff, reqLen)));
      stats.requests++;
      result = await perform(req, files, { fetchImpl, credentials });
    } catch (err) {
      result = { code: 2, message: String(err?.message ?? err), url: '', status: 0, headers: [] };
    }
    const bytes = new TextEncoder().encode(formatResult(result));
    if (bytes.length > resCap) return -bytes.length;
    new Uint8Array(memory.buffer, resOff, bytes.length).set(bytes);   // (a fresh view: memory may have grown)
    return bytes.length;
  }
  return { imports: { wasm_host: { http_request: new WebAssembly.Suspending(guarded(wasi, http_request)) } }, stats };
}

// One request (`req` of parseRequest; `input` and `output` are guest paths): the result for formatResult. The browser
// sets some request headers itself and drops the program's (User-Agent in Chromium, Accept-Encoding, Cookie, ...).
// Every failed fetch is the same TypeError without detail (refused, unresolved, TLS, CORS): libcurl's 7.
async function perform(req, files, { fetchImpl, credentials }) {
  try {
    const init = { method: req.method, headers: req.headers, redirect: 'follow', credentials };
    if (Number.isFinite(req.timeout)) init.signal = AbortSignal.timeout(Math.max(1, req.timeout * 1000));
    if (req.input) init.body = files.read(req.input).slice();
    const r = await fetchImpl(req.url, init);
    if (req.output) files.write(req.output, new Uint8Array(await r.arrayBuffer()));
    else await r.body?.cancel();
    // (fetch has no HTTP version: libcurl's status line for an HTTP/1.1 response)
    return { code: 0, message: '', url: r.url, status: r.status, headers: [...r.headers],
             statusLine: `HTTP/1.1 ${r.status}${r.statusText ? ' ' + r.statusText : ''}` };
  } catch (err) {
    const code = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? CURLE.OPERATION_TIMEDOUT :
                 err instanceof TypeError ? CURLE.COULDNT_CONNECT : CURLE.RECV_ERROR;
    return { code, message: String(err?.message ?? err), url: req.url, status: 0, statusLine: '', headers: [] };
  }
}

// The files of the shim's preopens, by guest path, through the shim's own directory operations (no import of the shim)
function shimFiles(wasi) {
  const normalize = (p) => '/' + String(p).split('/').reduce((a, s) => s === '..' ? a.slice(0, -1) : s && s !== '.' ? [...a, s] : a, []).join('/');
  // a guest path -> [the preopen containing it (the longest), the path relative to it]
  function locate(guest) {
    const g = normalize(guest);
    let best = null;
    for (const fd of wasi.fds) {
      if (fd?.prestat_name === undefined) continue;
      const name = normalize(typeof fd.prestat_name === 'string' ? fd.prestat_name : new TextDecoder().decode(fd.prestat_name));
      if ((g === name || g.startsWith(name === '/' ? name : name + '/')) && (!best || name.length > best[0].length)) best = [name, fd];
    }
    if (!best) throw new Error(`wasmhost: ${guest} is outside the preopens`);
    return [best[1], g.slice(best[0].length).replace(/^\//, '')];
  }
  return {
    read(guest) {
      const [pre, rel] = locate(guest);
      let n = pre.dir;
      for (const s of rel.split('/').filter(Boolean)) n = n?.contents?.get(s);
      if (!(n?.data instanceof Uint8Array)) throw new Error(`wasmhost: no file ${guest}`);
      return n.data;
    },
    write(guest, bytes) {
      const [pre, rel] = locate(guest);
      const { ret, fd_obj } = pre.path_open(0, rel, 1 | 8, 0n, 0n, 0);   // (O_CREAT | O_TRUNC)
      if (ret !== 0 || !fd_obj?.file) throw new Error(`wasmhost: can't create ${guest} (errno ${ret})`);
      fd_obj.file.data = bytes;
    },
  };
}
