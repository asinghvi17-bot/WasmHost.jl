// node | bun   crun.mjs MODULE.wasm MODE(jspi|sync|import) WORKDIR WASMCODEGEN [EVENTS(events|noevents)]
// Runs the module of cprog.jl (Julia tasks) or bprog.jl (a program of one task) on node:wasi with WasmHost's adapter
// (MODE jspi or sync: the spool transport; import: the import transport) against server.mjs (its tiles after a fixed
// latency, E2E_LATENCY_MS). A module with tasks (it imports julia_task) runs on WASMCODEGEN's js/julia_io.mjs events
// and js/julia_task.mjs, its `main` a root call of julia_task; the adapter gets the same events unless EVENTS is
// `noevents` (then each request suspends the whole module, as before WasmHost's concurrent requests). Prints the
// module's output, then the adapter's, the server's and julia_task's counters, and the files the module wrote.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WASI } from 'node:wasi';
import { wasiImportObject, wasiInitialize, jspiGap } from '../../js/node/wasi.mjs';
import { wrapWasi } from '../../js/node/spool.mjs';
import { makeImports } from '../../js/node/imports.mjs';

const [wasmPath, mode, work_, wcg, events_ = 'events'] = process.argv.slice(2);
const work = path.resolve(work_);
if ((mode === 'jspi' || mode === 'import') && jspiGap()) { console.log(`SKIP: ${jspiGap()}`); process.exit(77); }
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(work, 'out'), { recursive: true });

const server = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { const m = /listening (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
  server.on('exit', (c) => reject(new Error('server exited ' + c)));
});
const base = `http://127.0.0.1:${port}`;

try {
  const mod = new WebAssembly.Module(fs.readFileSync(wasmPath));
  const libs = [...new Set(WebAssembly.Module.imports(mod).map((i) => i.module))];
  console.error('imports:', libs.join(', '));
  const tasks = libs.includes('julia_task');
  const preopens = { [work]: work };
  const env = { FETCH_BASE: base, FETCH_OUT: path.join(work, 'out'), PWD: work, WASMHOST_SPOOL: path.join(work, '.wasmhost') };
  if (process.env.CPROG_N) env.CPROG_N = process.env.CPROG_N;
  fs.mkdirSync(env.WASMHOST_SPOOL, { recursive: true });
  const wasi = new WASI({ version: 'preview1', args: ['cprog'], env, preopens, returnOnExit: true });
  let imports = wasiImportObject(wasi);
  let events = null, paths = null, jt = null;
  if (tasks || libs.includes('julia_io')) {
    const io = await import(path.join(wcg, 'js', 'julia_io.mjs'));
    events = io.makeJuliaIOEvents();
    paths = io.makeJuliaIOPaths({ preopens: [work] });
    imports = { ...imports, julia_io: { ...paths.imports, ...events.imports } };
  }
  if (tasks) {
    const { makeJuliaTask } = await import(path.join(wcg, 'js', 'julia_task.mjs'));
    jt = makeJuliaTask({ events, onDeadlock: () => console.error('DEADLOCK') });
    imports = { ...imports, ...jt.imports };
  }
  const given = tasks && events_ === 'events' ? events : undefined;
  let adapter;
  if (mode === 'import') {
    adapter = makeImports({ preopens, events: given });
    imports = { ...imports, ...adapter.imports };
  } else {
    adapter = wrapWasi(imports.wasi_snapshot_preview1, { preopens, spool: env.WASMHOST_SPOOL, mode, events: given });
    imports = { ...imports, wasi_snapshot_preview1: adapter.wasiImport };
  }
  const inst = await WebAssembly.instantiate(mod, imports);
  adapter.bindMemory(inst.exports.memory);
  events?.bindMemory(inst.exports.memory);
  paths?.bindMemory(inst.exports.memory);
  wasiInitialize(wasi, inst);
  jt?.bind(inst);
  await fetch(`${base}/stats?reset=1`);
  const t0 = performance.now();
  const rc = jt ? await jt.call(inst.exports.main) :
             mode === 'sync' ? inst.exports.main() : await WebAssembly.promising(inst.exports.main)();
  const ms = performance.now() - t0;
  const st = await (await fetch(`${base}/stats`)).json();
  console.error(`main returned ${rc} in ${ms.toFixed(0)} ms (${tasks ? 'tasks' : 'one task'}, ${mode}, ${given ? 'with' : 'without'} julia_io events for the adapter)`);
  console.error(`host: ${JSON.stringify(adapter.stats)}`);
  console.error(`server: ${st.served} tile requests, at most ${st.maxInFlight} in flight at once, latency ${st.latencyMs} ms`);
  if (jt) console.error(`julia_task: ${JSON.stringify(jt.stats())}`);
  for (const f of fs.readdirSync(path.join(work, 'out')).sort()) {
    const b = fs.readFileSync(path.join(work, 'out', f));
    console.error(`file ${f} ${b.length} ${crypto.createHash('sha256').update(b).digest('hex')}`);
  }
  console.error('spool files left:', fs.readdirSync(env.WASMHOST_SPOOL).length);
  jt?.shutdown();
} finally {
  server.kill();
}
