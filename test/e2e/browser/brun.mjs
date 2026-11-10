// node test/e2e/browser/brun.mjs MODULE.wasm WASMCODEGEN CASE
// The browser counterpart of ../brun.mjs: brprog.jl's module in Playwright's headless Chromium with WasmHost's browser
// adapter and its bridge (page.mjs: window.runBridge; WASMCODEGEN's js/ served at /wcg/js/), the page's side of CASE
// (../bdrive.mjs), and the reentry case (direct calls while main is suspended). Prints "bridge: WHAT: true|false" per
// check and "BRIDGE PASS" or "BRIDGE FAIL" (exit status 1; a page error fails it too); exits 77 and prints
// "SKIP: ..." where the browser has no JSPI.
import path from 'node:path';
import { serveStatic, openPage } from './harness.mjs';

const [wasmPath, wcg, which] = process.argv.slice(2);
let stat = null, browser = null;
try {
  stat = await serveStatic(path.resolve(wasmPath), wcg);
  let page;
  ({ browser, page } = await openPage(stat.origin));
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const r = await page.evaluate((a) => window.runBridge(a), { wasm: '/module.wasm', which });
  if (r.jspiGap) { console.log(`SKIP: ${r.jspiGap}`); process.exitCode = 77; }
  else {
    for (const l of r.stdout) console.log(`stdout: ${l}`);
    for (const l of r.stderr) console.log(`stderr: ${l}`);
    console.log(`stats: ${JSON.stringify(r.stats)}`);
    // (a poisoned instance's spool files stay: the guard's error unwinds the module without its `finally` blocks)
    const checks = [...r.checks, ['no page errors', pageErrors.length === 0],
                    ...(which === 'reentry' ? [] : [['spool files left: 0', r.spoolLeft === 0]])];
    for (const e of pageErrors) console.log(`page error: ${e}`);
    for (const [what, ok] of checks) console.log(`bridge: ${what}: ${ok}`);
    const pass = checks.every(([, ok]) => ok);
    console.log(pass ? 'BRIDGE PASS' : 'BRIDGE FAIL');
    process.exitCode = pass ? 0 : 1;
  }
} finally {
  await browser?.close();
  stat?.server.close();
}
