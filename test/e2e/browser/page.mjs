// The page of the browser e2e (run.mjs drives it): runs prog.jl's module on @bjorn3/browser_wasi_shim with
// WasmHost's browser adapter, window.checkHostGuard checks the adapter's re-entry guard, and window.checkDecompress
// the adapter's decompression.
import { WASI, File, OpenFile, Directory, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
import { wrapWasi, makeImports, decompressFile, hasFormat, makeShimFs, jspiGap, promisingExports, isPoisoned, ReentryError, InstancePoisonedError } from '/js/browser/index.mjs';
import { oneAtATime } from '/js/browser/jspi.mjs';

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

// The module of both checks below, and the same wiring as runModule's: { out, root, adapter, inst, wasi }.
async function instantiate({ wasm, mode, base }) {
  const mod = await WebAssembly.compileStreaming(fetch(wasm));
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
    adapter = makeImports({ wasi, spool: '/work/.wasmhost' });
    imports = { wasi_snapshot_preview1: wasi.wasiImport, ...adapter.imports };
  } else {
    adapter = wrapWasi(wasi, { spool: '/work/.wasmhost' });
    imports = { wasi_snapshot_preview1: adapter.wasiImport };
  }
  const inst = await WebAssembly.instantiate(mod, imports);
  adapter.bindMemory(inst.exports.memory);
  wasi.initialize(inst);
  return { out, root, adapter, inst, wasi };
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
window.ready = true;
