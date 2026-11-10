// node test/e2e/browser/mrun.mjs MODULE.wasm WASMCODEGEN
// The browser counterpart of ../mrun.mjs: mprog.jl's module in Playwright's headless Chromium with WasmHost's browser
// adapter and its bridge. Real mouse, wheel and keyboard events on the canvas reach `events(scene)` in the module; the
// module's evaljs-style messages run in the page. Prints the page's log and "makie: WHAT: true|false" per check
// (../mdrive.mjs's checkMakie, and no page errors), then "MAKIE PASS" or "MAKIE FAIL" (exit status 1); exits 77 and
// prints "SKIP: ..." without JSPI.
import path from 'node:path';
import { serveStatic } from './harness.mjs';
import { chromium } from 'playwright';
import { checkMakie } from '../mdrive.mjs';

const [wasmPath, wcg] = process.argv.slice(2);
const stat = await serveStatic(path.resolve(wasmPath), wcg);
const browser = await chromium.launch();
let code = 0, page = null;
const pageErrors = [];
try {
  page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('[page error]', e.message); });
  await page.goto(`${stat.origin}/test/e2e/browser/mpage.html`);
  console.error(`browser: Chromium ${browser.version()}`);
  const r = await page.evaluate(() => window.startMakie({ wasm: '/module.wasm' }));
  if (r.jspiGap) { console.log(`SKIP: ${r.jspiGap}`); process.exit(77); }
  console.error('imports:', r.imports.join(', '), '| exports:', r.exports.join(', '));
  const until = (f) => page.waitForFunction(f, null, { timeout: 30000 });
  await until(() => window.bridgeState().commId !== null && window.bridgeState().parked);
  await page.mouse.move(60, 40);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.wheel(0, 120);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.up({ button: 'middle' });
  await page.focus('#c');
  await page.keyboard.press('a');
  await until(() => window.bridgeState().pending === 0 && window.bridgeState().stats.sent >= 7 && window.bridgeState().parked);
  await page.evaluate(() => { window.bridgePost({ msg_type: 'pick', x: 60, y: 40 }); });   // Julia asks the page for a pick
  await until(() => window.bridgeState().pending === 0 && window.bridgeState().stats.sent >= 9 && window.bridgeState().parked);
  const fin = await page.evaluate(() => window.finishMakie());
  const log = await page.evaluate(() => window.log);
  for (const l of log) console.log(l);
  console.error(`main returned ${fin.rc}; bridge ${JSON.stringify(fin.stats)}`);
  const pageLog = log.filter((l) => !l.startsWith('out ') && !l.startsWith('err '));
  const out = log.filter((l) => l.startsWith('out ')).map((l) => l.slice(4));
  const checks = [...checkMakie({ log: pageLog, out, rc: fin.rc, pos: '60.0,40.0', scroll: '0.0,1.0' }),
                  [`main did not reject (${fin.failure ?? ''})`, fin.failure === null], ['no page errors', pageErrors.length === 0]];
  for (const [what, ok] of checks) console.log(`makie: ${what}: ${ok}`);
  const pass = checks.every(([, ok]) => ok);
  console.log(pass ? 'MAKIE PASS' : 'MAKIE FAIL');
  code = pass ? 0 : 1;
} catch (e) {
  console.error('FAILED', e.message);
  console.log('MAKIE FAIL');
  console.error(JSON.stringify(await page?.evaluate?.(() => window.log).catch(() => null)));
  code = 1;
} finally {
  await browser.close();
  stat.server.close();
}
process.exit(code);
