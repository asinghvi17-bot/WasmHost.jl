// The browser e2e's harness: a static server for the page, the adapter (the repository's js/) and the module,
// and Playwright's headless Chromium on its page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };

// Serve the repository's files (and `wasm`, if given, as /module.wasm; WasmCodegen's js/, if `wcg` is its directory,
// as /wcg/js/) on 127.0.0.1: { server, origin }
export async function serveStatic(wasm, wcg) {
  const WCG = wcg ? path.join(path.resolve(wcg), 'js') : null;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = path.normalize(decodeURIComponent(u.pathname));
    const file = u.pathname === '/module.wasm' && wasm ? wasm :
      WCG && p.startsWith('/wcg/js/') ? path.join(WCG, p.slice('/wcg/js/'.length)) : path.join(ROOT, p);
    const inside = file.startsWith(ROOT + path.sep) || (WCG && file.startsWith(WCG + path.sep));
    if (!inside && file !== wasm || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end('not here\n');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// Open the e2e page in a headless Chromium: { browser, page }. The page's console goes to stderr.
export async function openPage(origin) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (m) => console.error('[page]', m.text()));
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto(`${origin}/test/e2e/browser/page.html`);
  await page.waitForFunction(() => window.ready === true);
  console.error(`browser: Chromium ${browser.version()}`);
  return { browser, page };
}
