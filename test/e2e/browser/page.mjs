// The page of the browser e2e (run.mjs drives it): runs prog.jl's module on @bjorn3/browser_wasi_shim with
// WasmHost's browser adapter, window.checkHostGuard checks the adapter's re-entry guard, and window.checkDecompress
// the adapter's decompression.
import { WASI, File, OpenFile, Directory, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
import { wrapWasi, makeImports, decompressFile, hasFormat, makeShimFs, makeShimJuliaIOPaths, jspiGap, promisingExports,
         isPoisoned, ReentryError, InstancePoisonedError, oneAtATime, notSuspended, makeBridge } from '/js/browser/index.mjs';
import { bridgeScenario } from '/test/e2e/bdrive.mjs';

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

// The module of the checks below, and the same wiring as runModule's: { out, root, adapter, inst, wasi, mod }.
// `mod` (an already compiled module) and `fetchImpl` (the adapter's fetch) are optional.
async function instantiate({ wasm, mode, base }, { mod = null, fetchImpl } = {}) {
  mod ??= await WebAssembly.compileStreaming(fetch(wasm));
  const out = { stdout: [], stderr: [] };
  const root = new PreopenDirectory('/work', new Map([['out', new Directory(new Map())]]));
  const env = [`FETCH_BASE=${base}`, 'FETCH_OUT=/work/out', 'PWD=/work', 'WASMHOST_SPOOL=/work/.wasmhost'];
  const wasi = new WASI(['fetch'], env, [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((l) => out.stdout.push(l)),
    ConsoleStdout.lineBuffered((l) => out.stderr.push(l)),
    root], { debug: false });
  let adapter, imports;
  if (mode === 'import') {
    adapter = makeImports({ wasi, spool: '/work/.wasmhost', fetchImpl });
    imports = { wasi_snapshot_preview1: wasi.wasiImport, ...adapter.imports };
  } else {
    adapter = wrapWasi(wasi, { spool: '/work/.wasmhost', fetchImpl });
    imports = { wasi_snapshot_preview1: adapter.wasiImport };
  }
  const inst = await WebAssembly.instantiate(mod, imports);
  adapter.bindMemory(inst.exports.memory);
  wasi.initialize(inst);
  return { out, root, adapter, inst, wasi, mod };
}

const settled = (p) => p.then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, name: e?.name, message: String(e?.message), cause: e?.cause?.name }));
// (whether a promise has settled after `ticks` microtask turns: what "rejects immediately" means)
const settlesSoon = async (p, ticks = 20) => {
  let done = false;
  settled(p).then(() => { done = true; });
  for (let i = 0; i < ticks; i++) await null;
  return done;
};

// window.checkReentry({ wasm, mode, base }) -> [what, ok]: the real module (prog.jl's) re-entered while it waits for the
// host: `main` is in flight through promisingExports (waiting for its first request); the page then calls the module
// again behind the queue's back, with WebAssembly.promising on the raw export (what a page that doesn't use
// promisingExports does), and queues another main through promisingExports. The host guard catches the re-entrant
// call's first request: it fails with a ReentryError, and the instance is poisoned. The suspended main rejects with an
// InstancePoisonedError when it would resume (not a result), the queued main rejects too without running, and a
// call after all that rejects at once.
window.checkReentry = async (cfg) => {
  const { adapter, inst } = await instantiate(cfg);
  const exports = promisingExports(inst);               // (queue: the default)
  const raw = WebAssembly.promising(inst.exports.main);
  const first = settled(exports.main());
  while (adapter.stats.requests + (adapter.stats.decompress ?? 0) === 0) await null;   // (main is suspended in its first request)
  const before = isPoisoned(inst);
  const reentrant = settled(raw());
  const queued = settled(exports.main());
  const [r0, r1, r2] = await Promise.all([first, reentrant, queued]);
  const later = exports.main();
  const immediate = await settlesSoon(later);
  const r3 = await settled(later);
  const requests = adapter.stats.requests;
  const afterwards = await Promise.all(Object.keys(exports).filter((k) => k !== 'memory').map((k) => settled(exports[k]())));
  const poisonedName = (r) => !r.ok && r.name === 'InstancePoisonedError' && r.cause === 'ReentryError';
  return [['not poisoned before the re-entrant call', before === false],
          [`the re-entrant call fails with a ReentryError (${r1.name})`, !r1.ok && r1.name === 'ReentryError'],
          ['the instance is poisoned', isPoisoned(inst) === true],
          [`the suspended main rejects with an InstancePoisonedError caused by the ReentryError (${r0.ok ? 'returned ' + r0.value : r0.name})`, poisonedName(r0)],
          [`the queued main rejects with an InstancePoisonedError (${r2.ok ? 'returned ' + r2.value : r2.name})`, poisonedName(r2)],
          [`a call after that rejects at once (${r3.name})`, immediate && poisonedName(r3)],
          ['the queued main never ran (only the suspended one\'s request was made)', requests === 1],
          ['every export rejects now', afterwards.length > 0 && afterwards.every(poisonedName)]];
};

// (outside the async check below, whose saved registers could keep the object alive): calls main with an argument
// only the returned WeakRef knows: { queued: the call's promise, token: the WeakRef }
function queueWithArgument(exports) {
  const o = { big: new Uint8Array(1 << 20) };
  return { queued: exports.main(o), token: new WeakRef(o) };
}

// window.checkStalledReentry({ wasm, mode, base }) -> [what, ok]: the first host job is held open (a fetch that doesn't
// settle until released), a main is queued behind it BEFORE the page re-enters the module, then the re-entrant call
// poisons the instance. The queued main rejects with an InstancePoisonedError at once, while the first job is still
// stalled (it is not waiting for it to settle), and a call after that rejects too. Then recovery: the held fetch is
// released (the suspended main rejects), and a new WASI instance and instance of the same compiled module run a main
// that succeeds.
window.checkStalledReentry = async (cfg) => {
  let release;
  const held = new Promise((r) => { release = r; });
  let fetches = 0;
  const stalled = async (...args) => { fetches++; await held; return fetch(...args); };
  const { inst, mod } = await instantiate(cfg, { fetchImpl: stalled });
  const exports = promisingExports(inst);
  const raw = WebAssembly.promising(inst.exports.main);
  const first = settled(exports.main());
  while (fetches === 0) await null;                      // (main is suspended in its first request, which is held open)
  // (queued behind it, before the re-entry, with an argument only a WeakRef knows: once rejected, nothing may keep
  // the argument alive while the first request is stalled)
  const { queued, token } = queueWithArgument(exports);
  const queuedSettled = settled(queued);
  const reentrant = await settled(raw());                // (the host guard: poisons the instance)
  const promptly = await settlesSoon(queued, 200);       // (the first job is still stalled: nothing released it)
  const stillStalled = fetches === 1;
  let collected = false;
  // (a deref keeps its target alive for the rest of the job, so each gc() starts one: after a turn of the event loop)
  for (let i = 0; i < 20 && !collected; i++) {
    await new Promise((r) => setTimeout(r, 10)); globalThis.gc?.(); await new Promise((r) => setTimeout(r, 10));
    collected = token.deref() === undefined;
  }
  if (!promptly) release();                              // (a failure must not hang the check)
  const r2 = await queuedSettled;
  const later = exports.main();
  const immediate = await settlesSoon(later);
  const r3 = await settled(later);
  const r0Early = await settlesSoon(first);              // (the suspended main isn't back before its request settles)
  release();
  const r0 = await first;
  const poisonedName = (r) => !r.ok && r.name === 'InstancePoisonedError' && r.cause === 'ReentryError';
  // a new instance from the same compiled module
  const fresh = await instantiate(cfg, { mod });
  const rc = await settled(promisingExports(fresh.inst).main());
  return [[`the re-entrant call fails with a ReentryError (${reentrant.name})`, !reentrant.ok && reentrant.name === 'ReentryError'],
          ['the first job is still stalled when the queued main is rejected', !r0Early && stillStalled],
          [`the queued main rejects at once, with an InstancePoisonedError (${r2.ok ? 'returned ' + r2.value : r2.name})`, promptly && poisonedName(r2)],
          [`a call after that rejects at once (${r3.name})`, immediate && poisonedName(r3)],
          ['the rejected queued call\'s argument is collected while the first request is still stalled', typeof globalThis.gc === 'function' && collected && stillStalled],
          [`the suspended main rejects with an InstancePoisonedError once its request settles (${r0.ok ? 'returned ' + r0.value : r0.name})`, poisonedName(r0)],
          ['the queued main never ran (only the first main made a request)', fetches === 1],
          ['the instance is poisoned, and a new one from the same module is not', isPoisoned(inst) && !isPoisoned(fresh.inst)],
          [`a new WASI and instance of the same module run a main normally (${rc.ok ? 'returned ' + rc.value : rc.name})`, rc.ok && rc.value === 0 && fresh.adapter.stats.requests > 0]];
};

// window.checkQueueAfterRejection() -> [what, ok]: promisingExports' queue on a module of two hand-assembled exports,
// `boom` (traps) and `ok` (returns 7): a call that rejects, executing, lets the queued ones run (whenBusy 'queue');
// with 'reject', the call after it is accepted too. A trap isn't a re-entrant call: nothing is poisoned.
window.checkQueueAfterRejection = async () => {
  // (module (func (export "boom") unreachable) (func (export "ok") (result i32) i32.const 7))
  const bytes = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    1, 8, 2, 0x60, 0, 0, 0x60, 0, 1, 0x7f,
    3, 3, 2, 0, 1,
    7, 13, 2, 4, 0x62, 0x6f, 0x6f, 0x6d, 0, 0, 2, 0x6f, 0x6b, 0, 1,
    10, 10, 2, 3, 0, 0, 0x0b, 4, 0, 0x41, 7, 0x0b]);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const q = promisingExports(instance);
  const [a, b, c] = await Promise.all([settled(q.boom()), settled(q.ok()), settled(q.ok())]);
  const d = await settled(q.ok());
  const rejecting = promisingExports((await WebAssembly.instantiate(bytes, {})).instance, { whenBusy: 'reject' });
  const e = await settled(rejecting.boom());
  const f = await settled(rejecting.ok());
  return [['the executing export rejects (the trap)', !a.ok && a.name === 'RuntimeError'],
          ['the call queued behind it runs', b.ok && b.value === 7],
          ['and the one behind that', c.ok && c.value === 7],
          ['a call after the queue drained runs', d.ok && d.value === 7],
          ['whenBusy reject: the trap rejects', !e.ok],
          ['whenBusy reject: the call after it is accepted', f.ok && f.value === 7],
          ['a trap does not poison', !isPoisoned(instance)]];
};

// window.checkHostGuard() -> [what, ok]: the adapter's guard of host jobs (oneAtATime) on its own, which a page that calls
// the module directly while it waits runs into: a second job of an instance is a ReentryError and poisons the instance
// (and the module instance its WASI instance was initialized with): the first job rejects with an InstancePoisonedError
// instead of resuming its caller, and so does every job after it; other instances are not blocked
window.checkHostGuard = async () => {
  const inst = {}, wasi = { inst }, run = oneAtATime(wasi), other = oneAtATime(wasi), elsewhere = oneAtATime({});
  let release;
  const first = settled(run(() => new Promise((r) => { release = r; })));
  const second = await settled(other(async () => 'ran'));
  const third = await settled(elsewhere(async () => 'ran'));       // (another instance: not blocked)
  const poisoned = isPoisoned(inst);
  release('first');
  const done = await first;
  const after = await settled(run(async () => 'ran'));
  return [['second job while the first is in flight: ReentryError', !second.ok && second.name === 'ReentryError'],
          ['the instance (not another) is poisoned', poisoned && !isPoisoned({}) && isPoisoned(wasi)],
          ['a job of another instance runs', third.ok && third.value === 'ran'],
          ['the first job rejects with an InstancePoisonedError', !done.ok && done.name === 'InstancePoisonedError' && done.cause === 'ReentryError'],
          ['a job after the first settled is refused', !after.ok && after.name === 'InstancePoisonedError'],
          ['a job without the guard hit runs', (await settled(oneAtATime({})(async () => 'ran'))).ok]];
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
  let polling = false;
  const events = { polling: () => polling };
  // (a fresh WASI instance per case: a guard hit poisons the one it hits)
  const guard = () => { const wasi = {}; return { wasi, check: notSuspended(wasi, events), run: oneAtATime(wasi, events) }; };
  const thrown = (f) => { try { f(); return null; } catch (e) { return e; } };
  const a = guard();
  const startsWhileRunning = thrown(a.check) === null && thrown(a.check) === null;   // (two starts of running tasks: both fine)
  polling = true;
  const b = guard();
  const startWhilePolling = thrown(b.check) instanceof ReentryError && isPoisoned(b.wasi);
  const startAfterPoison = thrown(b.check) instanceof InstancePoisonedError;
  const c = guard();
  const jobWhilePolling = await c.run(async () => 'ran').then(() => false, (e) => e instanceof ReentryError) && isPoisoned(c.wasi);
  polling = false;
  const d = guard();
  let release;
  const first = d.run(() => new Promise((r) => { release = r; })).then(() => null, (e) => e);
  const startWhileJob = thrown(d.check) instanceof ReentryError;
  release();
  const firstJob = await first;
  return [['starts while the module runs: allowed', startsWhileRunning && !isPoisoned(a.wasi)],
          ['a start while it is suspended in poll: ReentryError, and poisons', startWhilePolling],
          ['a start after that: InstancePoisonedError', startAfterPoison],
          ['a suspending job while it is suspended in poll: ReentryError, and poisons', jobWhilePolling],
          ['a start while a suspending job is in flight: ReentryError', startWhileJob],
          ['the job in flight then rejects with an InstancePoisonedError', firstJob instanceof InstancePoisonedError]];
};

// window.runBridge({ wasm, which }) -> { jspiGap } | { checks, stdout, stderr, stats, imports }: brprog.jl's module
// (Julia tasks, on WasmCodegen's julia_io events and julia_task from /wcg/js/) with the browser adapter's bridge, and
// the page's side of the case `which` (../bdrive.mjs). reentry: `poke_recv` and `poke` called directly
// (WebAssembly.promising on the raw exports) while main is suspended.
window.runBridge = async ({ wasm, which }) => {
  const out = { stdout: [], stderr: [], jspiGap: jspiGap() };
  if (out.jspiGap) return out;
  const mod = await WebAssembly.compileStreaming(fetch(wasm));
  out.imports = [...new Set(WebAssembly.Module.imports(mod).map((i) => i.module))];
  const io = await import('/wcg/js/julia_io.mjs');
  const { makeJuliaTask } = await import('/wcg/js/julia_task.mjs');
  const root = new PreopenDirectory('/work', new Map());
  const wasi = new WASI(['brprog'], ['PWD=/work', 'WASMHOST_SPOOL=/work/.wasmhost', `BRIDGE_CASE=${which}`], [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((l) => out.stdout.push(l)),
    ConsoleStdout.lineBuffered((l) => out.stderr.push(l)),
    root], { debug: false });
  const events = io.makeJuliaIOEvents();
  const paths = makeShimJuliaIOPaths(wasi);
  const jt = makeJuliaTask({ events, keepAlive: false, onDeadlock: () => out.stderr.push('DEADLOCK') });
  const s = bridgeScenario(makeBridge, events, which);
  const host = wrapWasi(wasi, { spool: '/work/.wasmhost', events, bridge: s.bridge });
  const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: host.wasiImport,
    julia_io: { ...paths.imports, ...events.imports }, ...jt.imports });
  host.bindMemory(inst.exports.memory); events.bindMemory(inst.exports.memory); paths.bindMemory(inst.exports.memory);
  wasi.initialize(inst); jt.bind(inst);
  const exports = promisingExports(inst, { tasks: jt });
  const raw = {
    poke: () => WebAssembly.promising(inst.exports.poke)(),
    poke_recv: () => WebAssembly.promising(inst.exports.poke_recv)(),
    isPoisoned: () => isPoisoned(inst),
    again: () => exports.main(),
  };
  // (write-fails: the adapter's next creation of an inbox file throws, in the shim's directory)
  let failInbox = false;
  const pathOpen = root.path_open.bind(root);
  root.path_open = (dirflags, path, oflags, ...rest) => {
    if (failInbox && (oflags & 1) && String(path).endsWith('.inb')) { failInbox = false; throw new Error('injected write failure'); }
    return pathOpen(dirflags, path, oflags, ...rest);
  };
  out.checks = await s.run({ main: exports.main(), stdout: () => out.stdout, raw, failInboxWrite: () => { failInbox = true; } });
  out.stats = s.bridge.stats;
  out.spoolLeft = root.dir.contents.get('.wasmhost')?.contents.size ?? -1;
  jt.shutdown();
  return out;
};
window.ready = true;
