// node test/e2e/browser/mrun.mjs MODULE.wasm WASMCODEGEN
// The browser counterpart of ../mrun.mjs: mprog.jl's module in Playwright's headless Chromium with WasmHost's browser
// adapter and its bridge. Real mouse, wheel and keyboard events on the canvas reach `events(scene)` in the module; the
// module's evaljs-style messages run in the page. Prints the page's log.
import path from 'node:path';
import { serveStatic } from './harness.mjs';
import { chromium } from 'playwright';

const [wasmPath, wcg] = process.argv.slice(2);
const stat = await serveStatic(path.resolve(wasmPath), wcg);
const browser = await chromium.launch();
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
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
  const fin = await page.evaluate(() => window.finishMakie());
  for (const l of await page.evaluate(() => window.log)) console.log(l);
  console.error(`main returned ${fin.rc}; bridge ${JSON.stringify(fin.stats)}`);
} catch (e) {
  console.error('FAILED', e.message);
  console.error(JSON.stringify(await page?.evaluate?.(() => window.log).catch(() => null)));
  code = 1;
} finally {
  await browser.close();
  stat.server.close();
}
process.exit(code);
