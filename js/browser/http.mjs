// WasmHost's downloads in a browser: one request of protocol "wasm-fetch 1" performed with the
// page's (or worker's) `fetch`, the bodies read from and written to the module's in-memory
// filesystem (`fs.mjs`).
import { CURLE } from '../common/fetch.mjs';

// libcurl's code of a failed browser `fetch`. A browser reports every network failure (refused,
// unresolved, TLS, a CORS refusal, too many redirects) as the same TypeError without detail, so
// all of them are libcurl's 7 (couldn't connect).
export function curlCode(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return CURLE.OPERATION_TIMEDOUT;
  if (err instanceof TypeError) return CURLE.COULDNT_CONNECT;
  return CURLE.RECV_ERROR;
}

// Perform one request (`req` of parseRequest; `input` and `output` are guest paths of `fs`):
// the result for formatResult.
//
// The browser sets some request headers itself and drops the program's: `User-Agent` in
// Chromium (Downloads' default one too), `Accept-Encoding`, `Cookie`, `Host` and the rest of
// the Fetch standard's forbidden request headers.
export async function perform(req, fs, { fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  try {
    const init = { method: req.method, headers: req.headers, redirect: 'follow' };
    if (Number.isFinite(req.timeout)) init.signal = AbortSignal.timeout(Math.max(1, req.timeout * 1000));
    if (req.input) init.body = fs.read(req.input).slice();
    const r = await fetchImpl(req.url, init);
    if (req.output) fs.write(req.output, new Uint8Array(await r.arrayBuffer()));
    else await r.body?.cancel();
    // (fetch joins repeated headers with ", "; a page never sees set-cookie)
    const headers = [];
    for (const [k, v] of r.headers) if (k !== 'set-cookie') headers.push([k, v]);
    for (const c of r.headers.getSetCookie?.() ?? []) headers.push(['set-cookie', c]);
    // (fetch has no HTTP version: libcurl's status line for an HTTP/1.1 response)
    return { code: 0, message: '', url: r.url, status: r.status,
             statusLine: `HTTP/1.1 ${r.status}${r.statusText ? ' ' + r.statusText : ''}`, headers };
  } catch (err) {
    return { code: curlCode(err), message: String(err?.message ?? err), url: req.url, status: 0, statusLine: '', headers: [] };
  }
}
