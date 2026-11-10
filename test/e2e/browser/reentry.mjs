// node test/e2e/browser/reentry.mjs MODULE.wasm MODE(jspi|import)
// The reentrancy checks of the browser adapter in Playwright's headless Chromium (page.mjs: window.checkReentry on the
// real module, MODULE.wasm, which ../run.mjs's programs are; window.checkQueueAfterRejection on a hand-assembled one).
// Prints "reentry: WHAT: true|false" per check and "REENTRY PASS" or "REENTRY FAIL" (exit status 1); exits 77 and
// prints "SKIP: ..." where the browser has no JSPI.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serveStatic, openPage } from './harness.mjs';

const [wasmPath, mode] = process.argv.slice(2);
if (mode !== 'jspi' && mode !== 'import') throw new Error(`mode ${mode}: jspi (spool) or import`);
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
  if (await page.evaluate(() => !(typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function'))) {
    console.log('SKIP: no JSPI in this browser'); process.exitCode = 77;
  } else {
    const checks = [...await page.evaluate((a) => window.checkReentry(a), { wasm: '/module.wasm', mode, base: `http://127.0.0.1:${port}` }),
                    ...await page.evaluate(() => window.checkQueueAfterRejection())];
    for (const [what, ok] of checks) console.log(`reentry: ${what}: ${ok}`);
    const pass = checks.every(([, ok]) => ok);
    console.log(pass ? 'REENTRY PASS' : 'REENTRY FAIL');
    process.exitCode = pass ? 0 : 1;
  }
} finally {
  await browser?.close();
  stat?.server.close();
  api.kill();
}
