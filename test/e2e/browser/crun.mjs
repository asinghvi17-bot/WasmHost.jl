// node test/e2e/browser/crun.mjs MODULE.wasm MODE(jspi|import) WORKDIR WASMCODEGEN [EVENTS(events|noevents)] [TWICE(queue|reject)]
// The browser counterpart of ../crun.mjs: cprog.jl's module (Julia tasks, on WASMCODEGEN's js/julia_io.mjs events
// and js/julia_task.mjs, which the page loads from /wcg/js/) or bprog.jl's in Playwright's headless Chromium with
// WasmHost's browser adapter, against ../server.mjs on another origin. Prints what ../crun.mjs prints. TWICE: `main`
// called twice at once through promisingExports (whenBusy TWICE); with reject, also the adapter's re-entry guard for
// a module with tasks (window.checkTaskGuard: "task guard ...").
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serveStatic, openPage } from './harness.mjs';

const [wasmPath, mode, work, wcg, events = 'events', twice_] = process.argv.slice(2);
const twice = twice_ || undefined;
if (mode !== 'jspi' && mode !== 'import') throw new Error(`mode ${mode}: jspi (spool) or import`);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const api = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
let stat = null, browser = null;
try {
  const port = await new Promise((resolve, reject) => {
    api.stdout.on('data', (d) => { const m = /listening (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    api.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  stat = await serveStatic(path.resolve(wasmPath), wcg);
  let page;
  ({ browser, page } = await openPage(stat.origin));
  const r = await page.evaluate((a) => window.runConcurrent(a),
    { wasm: '/module.wasm', mode, base: `http://127.0.0.1:${port}`, n: Number(process.env.CPROG_N ?? 14), events: events === 'events', twice });
  fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(r, null, 1));
  console.error(`user agent: ${r.userAgent}`);
  if (r.jspiGap) { console.log(`SKIP: ${r.jspiGap}`); process.exitCode = 77; }
  else {
    console.error('imports:', r.imports.join(', '));
    for (const l of r.stdout) console.log(l);
    for (const l of r.stderr) console.error(l);
    console.error(`main returned ${r.rc} in ${r.ms.toFixed(0)} ms (${r.tasks ? 'tasks' : 'one task'}, ${mode}, ${r.withEvents ? 'with' : 'without'} julia_io events for the adapter)`);
    if (twice) console.error(`second call: ${r.rc2}`);
    console.error(`exports: ${r.exports.join(', ')}`);
    console.error(`host: ${JSON.stringify(r.host)}`);
    console.error(`server: ${r.server.served} tile requests, at most ${r.server.maxInFlight} in flight at once, latency ${r.server.latencyMs} ms`);
    if (r.jt) console.error(`julia_task: ${JSON.stringify(r.jt)}`);
    for (const f of r.files) console.error(f);
    if (twice === 'reject')
      for (const [what, ok] of await page.evaluate(() => window.checkTaskGuard())) console.error(`task guard: ${what}: ${ok}`);
    console.error('spool files left:', r.spoolLeft);
  }
} finally {
  await browser?.close();
  stat?.server.close();
  api.kill();
}
