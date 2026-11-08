// node test/e2e/browser/run.mjs MODULE.wasm MODE(jspi|import) WORKDIR [TWICE(queue|reject)]
// The browser counterpart of ../run.mjs: starts ../server.mjs (the test resources, on its own port: a cross-origin
// server for the page, with CORS), serves the page, the adapter and the module from another port, and runs the
// module's `main` in Playwright's headless Chromium with WasmHost's browser adapter (MODE jspi: the spool transport;
// import: the import transport). Prints what ../run.mjs prints, for e2e.jl to compare with native, and the
// browser's User-Agent (which replaces Downloads' own). WORKDIR gets the page's result as result.json.
// TWICE: `main` called twice at once through promisingExports (whenBusy TWICE), the second call's result printed
// ("second call: ..."); with reject, also the adapter's host guard (window.checkHostGuard: "host guard ...").
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serveStatic, openPage } from './harness.mjs';

const [wasmPath, mode, work, twice] = process.argv.slice(2);
if (mode !== 'jspi' && mode !== 'import') throw new Error(`mode ${mode}: jspi (spool) or import`);
if (twice !== undefined && twice !== 'queue' && twice !== 'reject') throw new Error(`twice ${twice}: queue or reject`);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const api = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
let stat = null, browser = null;
try {
  const port = await new Promise((resolve, reject) => {
    api.stdout.on('data', (d) => { const m = /listening (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    api.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  stat = await serveStatic(path.resolve(wasmPath));
  let page;
  ({ browser, page } = await openPage(stat.origin));
  const r = await page.evaluate((a) => window.runModule(a), { wasm: '/module.wasm', mode, base: `http://127.0.0.1:${port}`, twice });
  fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(r, null, 1));
  console.error(`user agent: ${r.userAgent}`);
  if (r.jspiGap) { console.log(`SKIP: ${r.jspiGap}`); process.exitCode = 77; }
  else {
    console.error('imports:', r.imports.join(', '));
    for (const l of r.stdout) console.log(l);
    for (const l of r.stderr) console.error(l);
    console.error(`main returned ${r.rc} in ${r.ms.toFixed(0)} ms; host requests: ${r.requests}`);
    if (twice) console.error(`second call: ${r.rc2}`);
    if (twice === 'reject')
      for (const [what, ok] of await page.evaluate(() => window.checkHostGuard())) console.error(`host guard: ${what}: ${ok}`);
    if (r.blob) console.error(`blob.bin: ${r.blob.length} bytes, sha256 ${r.blob.sha256}, identical to the server's: ${r.blob.identical}`);
    console.error('spool files left:', r.spoolLeft);
  }
} finally {
  await browser?.close();
  stat?.server.close();
  api.kill();
}
