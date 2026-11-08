// The page of the bridge's browser e2e (mrun.mjs drives it): mprog.jl's module (Makie, tasks) on
// @bjorn3/browser_wasi_shim with WasmHost's browser adapter and its bridge. The canvas forwards its DOM events the way
// WGLMakie.js does (`comm.notify({mousedown: buttons})`, ...), as the UpdateObservable message Bonito sends for `comm`;
// the module's evaljs-style messages run here. Playwright produces real mouse and keyboard events on the canvas.
import { WASI, File, OpenFile, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
import { wrapWasi, makeShimJuliaIOPaths, jspiGap, promisingExports, makeBridge } from '/js/browser/index.mjs';

window.log = [];     // what the module's evaljs messages printed (JS ...) and its other messages (R ...)
let commId = null, main = null, bridge = null, jt = null;

// window.startMakie({ wasm }) -> { jspiGap } | { imports, exports }: instantiate and start `main`, which stays in flight
// (suspended in julia_io's poll, parked in Bridge.recv) for as long as the page runs
window.startMakie = async ({ wasm }) => {
  const out = { userAgent: navigator.userAgent, stdout: [], jspiGap: jspiGap() };
  if (out.jspiGap) return out;
  const mod = await WebAssembly.compileStreaming(fetch(wasm));
  out.imports = [...new Set(WebAssembly.Module.imports(mod).map((i) => i.module))];
  const io = await import('/wcg/js/julia_io.mjs');
  const { makeJuliaTask } = await import('/wcg/js/julia_task.mjs');
  const root = new PreopenDirectory('/work', new Map());
  const wasi = new WASI(['mprog'], ['PWD=/work', 'WASMHOST_SPOOL=/work/.wasmhost'], [
    new OpenFile(new File([])), ConsoleStdout.lineBuffered((l) => window.log.push('out ' + l)),
    ConsoleStdout.lineBuffered((l) => window.log.push('err ' + l)), root], { debug: false });
  const events = io.makeJuliaIOEvents();
  const paths = makeShimJuliaIOPaths(wasi);
  jt = makeJuliaTask({ events, keepAlive: false, onDeadlock: () => window.log.push('DEADLOCK') });
  bridge = makeBridge({ events, onMessage: (v) => {
    if (v.msg_type === '2') {              // Bonito's EvalJavascript
      new Function('console', 'Bonito', v.payload.source)({ log: (...a) => window.log.push('JS ' + a.join(' ')) }, {});
    } else {
      if (v.msg_type === 'hello') commId = v.comm;
      window.log.push('R ' + JSON.stringify(v));
    }
  } });
  const host = wrapWasi(wasi, { spool: '/work/.wasmhost', events, bridge });
  const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: host.wasiImport,
    julia_io: { ...paths.imports, ...events.imports }, ...jt.imports });
  host.bindMemory(inst.exports.memory); events.bindMemory(inst.exports.memory); paths.bindMemory(inst.exports.memory);
  wasi.initialize(inst); jt.bind(inst);
  const exports = promisingExports(inst, { tasks: jt });
  out.exports = Object.keys(exports);
  // the canvas, as WGLMakie.js wires it: one UpdateObservable of `comm` per event
  const upd = (payload) => commId !== null && bridge.post({ msg_type: '0', id: commId, payload });
  const c = document.getElementById('c');
  const xy = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  c.addEventListener('mousemove', (e) => upd({ mouseposition: xy(e) }));
  c.addEventListener('mousedown', (e) => upd({ mousedown: e.buttons }));
  c.addEventListener('mouseup', (e) => upd({ mouseup: e.buttons }));
  c.addEventListener('wheel', (e) => { e.preventDefault(); upd({ scroll: [e.deltaX, e.deltaY] }); }, { passive: false });
  c.addEventListener('keydown', (e) => upd({ keydown: [e.code, e.key] }));
  c.addEventListener('keyup', (e) => upd({ keyup: e.code }));
  main = exports.main();
  main.catch((e) => window.log.push('main rejected ' + e));
  return out;
};

window.bridgeState = () => ({ commId, parked: bridge?.parked(), stats: bridge?.stats, pending: bridge?.pending() });

// window.finishMakie() -> the result of `main`, after the page tells the module to stop
window.finishMakie = async () => {
  bridge.post({ msg_type: 'stop' });
  const rc = await main;
  return { rc, stats: bridge.stats, jt: jt.stats?.() };
};
