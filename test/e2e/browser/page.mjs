// The page of the browser e2e (run.mjs drives it): prog.jl's module (the import transport) on @bjorn3/browser_wasi_shim
// with WasmHost's browser adapter.
import { WASI, File, OpenFile, Directory, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
import { makeImports, jspiGap, promisingExports, isPoisoned } from '/js/browser/index.mjs';

const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

// a new WASI instance and instance of `mod`: { out, root, host, inst, exports }
async function instantiate(mod, base) {
  const out = { stdout: [], stderr: [] };
  const root = new PreopenDirectory('/work', new Map([['out', new Directory(new Map())], ['.wasmhost', new Directory(new Map())]]));
  const env = [`FETCH_BASE=${base}`, 'FETCH_OUT=/work/out', 'PWD=/work', 'WASMHOST_SPOOL=/work/.wasmhost'];
  const wasi = new WASI(['fetch'], env, [new OpenFile(new File([])), ConsoleStdout.lineBuffered((l) => out.stdout.push(l)),
                                         ConsoleStdout.lineBuffered((l) => out.stderr.push(l)), root], { debug: false });
  const host = makeImports({ wasi });
  const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport, ...host.imports });
  wasi.initialize(inst);
  return { out, root, host, inst, exports: promisingExports(inst) };
}

// window.runModule({ wasm, base }) -> what run.mjs prints
window.runModule = async ({ wasm, base }) => {
  const r = { userAgent: navigator.userAgent, jspiGap: jspiGap() };
  if (r.jspiGap) return r;
  const mod = await WebAssembly.compileStreaming(fetch(wasm));
  const { out, root, host, exports } = await instantiate(mod, base);
  const t0 = performance.now();
  r.rc = await exports.main();
  Object.assign(r, out, { ms: performance.now() - t0, requests: host.stats.requests });
  const blob = root.dir.contents.get('out').contents.get('blob.bin');
  if (blob) {
    const want = new Uint8Array(await (await fetch(`${base}/blob.bin`)).arrayBuffer());
    r.blob = { length: blob.data.length, sha256: hex(await crypto.subtle.digest('SHA-256', blob.data)),
               identical: blob.data.length === want.length && blob.data.every((x, i) => x === want[i]) };
  }
  r.spoolLeft = root.dir.contents.get('.wasmhost').contents.size;
  return r;
};

// window.checkCalls({ wasm, base }) -> [what, ok]: two calls at once are queued; a call behind the queue's back while
// main waits for the host poisons the instance (it, main and the queued call reject); a new instance runs normally.
window.checkCalls = async ({ wasm, base }) => {
  const mod = await WebAssembly.compileStreaming(fetch(wasm));
  const settled = (p) => p.then((value) => ({ ok: true, value }), (e) => ({ ok: false, name: e?.name }));
  const poisoned = (r) => !r.ok && r.name === 'InstancePoisonedError';
  const a = await instantiate(mod, base);
  const both = await Promise.all([settled(a.exports.main()), settled(a.exports.main())]);
  const b = await instantiate(mod, base);
  const first = settled(b.exports.main());
  while (b.host.stats.requests === 0) await null;                    // (main is suspended in its first request)
  const queued = settled(b.exports.main());
  const reentrant = settled(WebAssembly.promising(b.inst.exports.main)());   // (behind promisingExports' back)
  const [r0, r1, r2] = await Promise.all([first, queued, reentrant]);
  const later = await settled(b.exports.main());
  const c = await instantiate(mod, base);
  const fresh = await settled(c.exports.main());
  return [['two calls at once: both return 0, one after the other', both.every((r) => r.ok && r.value === 0) && !isPoisoned(a.inst)],
          [`the re-entrant call rejects with an InstancePoisonedError (${r2.name})`, poisoned(r2)],
          [`the suspended main rejects with it (${r0.name})`, poisoned(r0)],
          [`the queued main rejects with it, without running (${r1.name})`, poisoned(r1) && b.host.stats.requests === 1],
          [`a later call rejects with it (${later.name})`, poisoned(later) && isPoisoned(b.inst)],
          [`a new instance of the module runs normally (${fresh.ok ? fresh.value : fresh.name})`, fresh.ok && fresh.value === 0 && !isPoisoned(c.inst)]];
};
window.ready = true;
