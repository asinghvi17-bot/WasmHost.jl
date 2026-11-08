// WasmHost's downloads on Node: one request of protocol "wasm-fetch 1" performed with `fetch`,
// the body streamed to or from files of the host.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { curlCode } from '../common/fetch.mjs';
import { requestSignal } from '../common/jobs.mjs';

// Perform one request (`req` of parseRequest, with `outputHost`/`inputHost` mapped, or with
// `body`, bytes, instead of an input): the result for formatResult. `signal` aborts it (the module gave up a request it started).
export async function perform(req, { fetchImpl = globalThis.fetch, signal } = {}) {
  try {
    const init = { method: req.method, headers: req.headers, redirect: 'follow' };
    const sig = requestSignal(req.timeout, signal);
    if (sig) init.signal = sig;
    if (req.body) init.body = req.body;
    else if (req.inputHost) init.body = fs.readFileSync(req.inputHost);
    const r = await fetchImpl(req.url, init);
    if (req.outputHost && r.body) {
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(req.outputHost));
    } else if (req.outputHost) {
      fs.writeFileSync(req.outputHost, new Uint8Array());
    } else if (r.body) {
      await r.body.cancel();
    }
    // (fetch joins repeated headers with ", "; set-cookie kept apart, as libcurl gives them)
    const headers = [];
    for (const [k, v] of r.headers) if (k !== 'set-cookie') headers.push([k, v]);
    for (const c of r.headers.getSetCookie?.() ?? []) headers.push(['set-cookie', c]);
    // (fetch has no HTTP version: libcurl's status line for an HTTP/1.1 response)
    return { code: 0, message: '', url: r.url, status: r.status,
             statusLine: `HTTP/1.1 ${r.status}${r.statusText ? ' ' + r.statusText : ''}`, headers };
  } catch (err) {
    const msg = err?.cause?.message ? `${err.message}: ${err.cause.message}` : String(err?.message ?? err);
    return { code: curlCode(err), message: msg, url: req.url, status: 0, statusLine: '', headers: [] };
  }
}
