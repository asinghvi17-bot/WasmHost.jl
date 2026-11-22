// node test/e2e/browser/run.mjs MODULE.wasm [calls]
// The browser counterpart of ../run.mjs (import transport): starts ../server.mjs (the test resources, a cross-origin
// server for the page, with CORS), serves the page, the adapter and the module from another port, and runs the
// module's `main` in Playwright's headless Chromium with WasmHost's browser adapter. Prints what ../run.mjs prints,
// and the browser's User-Agent (which replaces Downloads' own). `calls`: page.mjs's checkCalls instead, one line per
// check, then "CALLS PASS" or "CALLS FAIL". Exits 77 with "SKIP: ..." where the browser has no JSPI.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const [wasmPath, what = 'run'] = process.argv.slice(2);
const wasm = path.resolve(wasmPath);

const api = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
// the repository's files, and the module as /module.wasm
const stat = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const file = u.pathname === '/module.wasm' ? wasm : path.join(ROOT, path.normalize(decodeURIComponent(u.pathname)));
  if (file !== wasm && !file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end();
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
let browser = null;
try {
  const port = await new Promise((resolve, reject) => {
    api.stdout.on('data', (d) => { const m = /listening (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    api.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  await new Promise((resolve) => stat.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (m) => console.error('[page]', m.text()));
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto(`http://127.0.0.1:${stat.address().port}/test/e2e/browser/page.html`);
  await page.waitForFunction(() => window.ready === true);
  console.error(`browser: Chromium ${browser.version()}`);
  const cfg = { wasm: '/module.wasm', base: `http://127.0.0.1:${port}` };
  const gap = await page.evaluate(() => !(typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function'));
  if (gap) { console.log('SKIP: no JSPI in this browser'); process.exitCode = 77; }
  else if (what === 'calls') {
    const checks = await page.evaluate((a) => window.checkCalls(a), cfg);
    for (const [check, ok] of checks) console.log(`calls: ${check}: ${ok}`);
    const pass = checks.every(([, ok]) => ok);
    console.log(pass ? 'CALLS PASS' : 'CALLS FAIL');
    process.exitCode = pass ? 0 : 1;
  } else {
    const r = await page.evaluate((a) => window.runModule(a), cfg);
    console.error(`user agent: ${r.userAgent}`);
    for (const l of r.stdout) console.log(l);
    for (const l of r.stderr) console.error(l);
    console.error(`main returned ${r.rc} in ${r.ms.toFixed(0)} ms; host requests: ${r.requests}`);
    if (r.blob) console.error(`blob.bin: ${r.blob.length} bytes, sha256 ${r.blob.sha256}, identical to the server's: ${r.blob.identical}`);
    console.error('spool files left:', r.spoolLeft);
  }
} finally {
  await browser?.close();
  stat.close();
  api.kill();
}
