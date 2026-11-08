// The page of the browser e2e (run.mjs drives it): runs prog.jl's module on @bjorn3/browser_wasi_shim with
// WasmHost's browser adapter, window.checkHostGuard checks the adapter's re-entry guard, and window.checkDecompress
// the adapter's decompression.
import { WASI, File, OpenFile, Directory, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
import { wrapWasi, makeImports, decompressFile, hasFormat, makeShimFs, makeShimJuliaIOPaths, jspiGap, promisingExports,
         ReentryError, oneAtATime, notSuspended } from '/js/browser/index.mjs';

const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (b) => hex(await crypto.subtle.digest('SHA-256', b));

// window.runModule({ wasm, mode: 'jspi' (spool transport) | 'import', base, twice }) -> what run.mjs prints. twice:
// 'queue' or 'reject', main called twice at once through promisingExports with that `whenBusy` (rc2: the second call's)
window.runModule = async ({ wasm, mode, base, twice }) => {
  const out = { userAgent: navigator.userAgent, stdout: [], stderr: [], jspiGap: jspiGap() };
  if (out.jspiGap) return out;
  const mod = await WebAssembly.compileStreaming(fetch(wasm));
  out.imports = [...new Set(WebAssembly.Module.imports(mod).map((i) => i.module))];
  const root = new PreopenDirectory('/work', new Map([['out', new Directory(new Map())]]));
  const env = [`FETCH_BASE=${base}`, 'FETCH_OUT=/work/out', 'PWD=/work', 'WASMHOST_SPOOL=/work/.wasmhost'];
  const wasi = new WASI(['fetch'], env, [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((l) => out.stdout.push(l)),
    ConsoleStdout.lineBuffered((l) => out.stderr.push(l)),
    root], { debug: false });
  let adapter, imports;
  if (mode === 'import') {
    adapter = makeImports({ wasi, spool: '/work/.wasmhost' });
    imports = { wasi_snapshot_preview1: wasi.wasiImport, ...adapter.imports };
  } else {
    adapter = wrapWasi(wasi, { spool: '/work/.wasmhost' });
    imports = { wasi_snapshot_preview1: adapter.wasiImport };
  }
  const inst = await WebAssembly.instantiate(mod, imports);
  adapter.bindMemory(inst.exports.memory);
  wasi.initialize(inst);
  const t0 = performance.now();
  const exports = promisingExports(inst, { whenBusy: twice ?? 'queue' });
  if (!twice) out.rc = await exports.main();
  else {
    const settled = (p) => p.then((v) => String(v), (e) => `rejected: ${e?.name}: ${e?.message}`);
    [out.rc, out.rc2] = await Promise.all([settled(exports.main()), settled(exports.main())]);
  }
  out.ms = performance.now() - t0;
  out.requests = adapter.stats.requests;
  const blob = root.dir.contents.get('out').contents.get('blob.bin');
  if (blob) {
    const want = new Uint8Array(await (await fetch(`${base}/blob.bin`)).arrayBuffer());
    out.blob = { length: blob.data.length, sha256: await sha256(blob.data),
                 identical: blob.data.length === want.length && blob.data.every((x, i) => x === want[i]) };
  }
  out.spoolLeft = root.dir.contents.get('.wasmhost')?.contents.size ?? -1;
  return out;
};

// window.checkHostGuard() -> [what, ok]: the adapter's guard of host jobs (oneAtATime), which a page that calls the
// module directly while it waits runs into: a second job of an instance is a ReentryError until the first settles
window.checkHostGuard = async () => {
  const wasi = {}, run = oneAtATime(wasi), other = oneAtATime(wasi), elsewhere = oneAtATime({});
  let release;
  const first = run(() => new Promise((r) => { release = r; }));
  const second = await other(async () => 'ran').then((v) => v, (e) => e);
  const third = await elsewhere(async () => 'ran');       // (another instance: not blocked)
  release('first');
  const done = await first;
  const after = await run(async () => 'ran');
  return [['second job while the first is in flight: ReentryError', second instanceof ReentryError],
          ['a job of another instance runs', third === 'ran'],
          ['the first job completes', done === 'first'],
          ['a job after the first settled runs', after === 'ran']];
};

// window.checkDecompress(cases) -> [{ name, errno, message, sha256, dstExists }]: decompressFile on the shim's
// filesystem, for run.mjs to compare with node:zlib. cases: [{ name, data (base64), format }]
window.checkDecompress = async (cases) => {
  const root = new PreopenDirectory('/d', new Map());
  const wasi = new WASI([], [], [new OpenFile(new File([])), new OpenFile(new File([])), new OpenFile(new File([])), root], { debug: false });
  const fs = makeShimFs(wasi);
  const res = [];
  for (const c of cases) {
    if (c.data !== null) fs.write(`/d/${c.name}.in`, Uint8Array.from(atob(c.data), (ch) => ch.charCodeAt(0)));
    const [errno, message] = await decompressFile(fs, `/d/${c.name}.in`, `/d/${c.name}.out`, c.format);
    const dstExists = fs.exists(`/d/${c.name}.out`);
    res.push({ name: c.name, errno, message, dstExists, sha256: dstExists ? await sha256(fs.read(`/d/${c.name}.out`)) : null });
  }
  return { zstd: hasFormat('zstd'), results: res };
};

// window.runConcurrent({ wasm, mode: 'jspi' (spool transport) | 'import', base, n, events, twice }) -> what
// ../crun.mjs prints: cprog.jl's module (Julia tasks: on WasmCodegen's julia_io events and julia_task, served at
// /wcg/js/, its exports called through promisingExports with julia_task) or bprog.jl's (a program of one task).
// events: whether the adapter gets the julia_io events (its requests overlap). twice: 'queue' or 'reject', main
// called twice at once (rc2: the second call's). window.checkTaskGuard: a host call while the module is suspended
// in julia_io's poll (a direct, re-entrant call) is refused, and is not while the module runs.
window.runConcurrent = async ({ wasm, mode, base, n, events: useEvents = true, twice }) => {
  const out = { userAgent: navigator.userAgent, stdout: [], stderr: [], jspiGap: jspiGap() };
  if (out.jspiGap) return out;
  const mod = await WebAssembly.compileStreaming(fetch(wasm));
  out.imports = [...new Set(WebAssembly.Module.imports(mod).map((i) => i.module))];
  const tasks = out.imports.includes('julia_task');
  const root = new PreopenDirectory('/work', new Map([['out', new Directory(new Map())]]));
  const env = [`FETCH_BASE=${base}`, 'FETCH_OUT=/work/out', 'PWD=/work', 'WASMHOST_SPOOL=/work/.wasmhost', `CPROG_N=${n}`];
  const wasi = new WASI(['cprog'], env, [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((l) => out.stdout.push(l)),
    ConsoleStdout.lineBuffered((l) => out.stderr.push(l)),
    root], { debug: false });
  let imports = { wasi_snapshot_preview1: wasi.wasiImport };
  let events = null, paths = null, jt = null;
  if (tasks || out.imports.includes('julia_io')) {
    const io = await import('/wcg/js/julia_io.mjs');
    events = io.makeJuliaIOEvents();
    paths = makeShimJuliaIOPaths(wasi);
    imports.julia_io = { ...paths.imports, ...events.imports };
  }
  if (tasks) {
    const { makeJuliaTask } = await import('/wcg/js/julia_task.mjs');
    jt = makeJuliaTask({ events, keepAlive: false, onDeadlock: () => out.stderr.push('DEADLOCK') });
    Object.assign(imports, jt.imports);
  }
  const given = tasks && useEvents ? events : undefined;
  let adapter;
  if (mode === 'import') {
    adapter = makeImports({ wasi, spool: '/work/.wasmhost', events: given });
    Object.assign(imports, adapter.imports);
  } else {
    adapter = wrapWasi(wasi, { spool: '/work/.wasmhost', events: given });
    imports.wasi_snapshot_preview1 = adapter.wasiImport;
  }
  const inst = await WebAssembly.instantiate(mod, imports);
  adapter.bindMemory(inst.exports.memory);
  events?.bindMemory(inst.exports.memory);
  paths?.bindMemory(inst.exports.memory);
  wasi.initialize(inst);
  jt?.bind(inst);
  await fetch(`${base}/stats?reset=1`);
  const exports = promisingExports(inst, { whenBusy: twice ?? 'queue', tasks: jt ?? undefined });
  out.exports = Object.keys(exports);
  const t0 = performance.now();
  if (!twice) out.rc = await exports.main();
  else {
    const settled = (p) => p.then((v) => String(v), (e) => `rejected: ${e?.name}: ${e?.message}`);
    [out.rc, out.rc2] = await Promise.all([settled(exports.main()), settled(exports.main())]);
  }
  out.ms = performance.now() - t0;
  out.tasks = tasks;
  out.withEvents = !!given;
  out.host = adapter.stats;
  out.server = await (await fetch(`${base}/stats`)).json();
  out.jt = jt?.stats();
  out.files = [];
  for (const [name, f] of [...root.dir.contents.get('out').contents].sort(([a], [b]) => (a < b ? -1 : 1)))
    out.files.push(`file ${name} ${f.data.length} ${await sha256(f.data)}`);
  out.spoolLeft = root.dir.contents.get('.wasmhost')?.contents.size ?? -1;
  jt?.shutdown();
  return out;
};

window.checkTaskGuard = async () => {
  const wasi = {};
  let polling = false;
  const events = { polling: () => polling };
  const check = notSuspended(wasi, events), run = oneAtATime(wasi, events);
  const refused = (f) => { try { f(); return false; } catch (e) { return e instanceof ReentryError; } };
  const startsWhileRunning = !refused(check) && !refused(check);       // (two starts of running tasks: both fine)
  polling = true;
  const startWhilePolling = refused(check);
  const jobWhilePolling = await run(async () => 'ran').then(() => false, (e) => e instanceof ReentryError);
  polling = false;
  let release;
  const first = run(() => new Promise((r) => { release = r; }));
  const startWhileJob = refused(check);
  release();
  await first;
  return [['starts while the module runs: allowed', startsWhileRunning],
          ['a start while it is suspended in poll: ReentryError', startWhilePolling],
          ['a suspending job while it is suspended in poll: ReentryError', jobWhilePolling],
          ['a start while a suspending job is in flight: ReentryError', startWhileJob]];
};
window.ready = true;
