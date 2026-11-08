// node brun.mjs MODULE.wasm WORKDIR WASMCODEGEN
// Runs brprog.jl's module (Julia tasks, WasmHost.Bridge) on node:wasi: the page side posts messages while the module's
// `main` is in flight and parked in `recv`, and the module's replies arrive through `onMessage`. Prints "R..." lines
// (checked by e2e.jl).
import fs from 'node:fs';
import path from 'node:path';
import { WASI } from 'node:wasi';
import { wasiImportObject, wasiInitialize, jspiGap } from '../../js/node/wasi.mjs';
import { wrapWasi } from '../../js/node/spool.mjs';
import { makeBridge } from '../../js/common/bridge.mjs';

const [wasmPath, work_, wcg] = process.argv.slice(2);
const work = path.resolve(work_);
if (jspiGap()) { console.log(`SKIP: ${jspiGap()}`); process.exit(77); }
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const spool = path.join(work, '.wasmhost');
fs.mkdirSync(spool, { recursive: true });

const mod = new WebAssembly.Module(fs.readFileSync(wasmPath));
const io = await import(path.join(wcg, 'js', 'julia_io.mjs'));
const { makeJuliaTask } = await import(path.join(wcg, 'js', 'julia_task.mjs'));
const events = io.makeJuliaIOEvents();
const paths = io.makeJuliaIOPaths({ preopens: [work] });
const jt = makeJuliaTask({ events, onDeadlock: () => console.log('DEADLOCK') });

const log = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let onPong = null;
const bridge = makeBridge({ events, onMessage: (v) => {
  log.push(v);
  console.log('R', JSON.stringify(v, (k, x) => ArrayBuffer.isView(x) ? { [x.constructor.name]: Array.from(x) } : x));
  if (v.type === 'pong' && onPong) onPong(v);
} });

const wasi = new WASI({ version: 'preview1', args: ['brprog'], env: { PWD: work, WASMHOST_SPOOL: spool }, preopens: { [work]: work }, returnOnExit: true });
const host = wrapWasi(wasiImportObject(wasi).wasi_snapshot_preview1, { preopens: { [work]: work }, spool, mode: 'jspi', events, bridge });
const inst = await WebAssembly.instantiate(mod, { ...wasiImportObject(wasi), wasi_snapshot_preview1: host.wasiImport,
  julia_io: { ...paths.imports, ...events.imports }, ...jt.imports });
host.bindMemory(inst.exports.memory); events.bindMemory(inst.exports.memory); paths.bindMemory(inst.exports.memory);
wasiInitialize(wasi, inst);
jt.bind(inst);

// the page, while main is in flight: it posts only once the module is parked in recv (it never calls into the module)
const main = jt.call(inst.exports.main);
main.catch((e) => console.log('main rejected', e));
while (!bridge.parked()) await wait(5);
const t0 = performance.now();
const pong = () => new Promise((r) => { onPong = r; });
let p = pong();
bridge.post({ type: 'ping', v: new Float32Array([1, 2, 3.5]), s: 'café' });
await p;
// two posts at once: the module takes both in one recv
p = pong();
bridge.post({ type: 'ping', v: new Float32Array([10]) });
bridge.post({ type: 'ping', v: new Float32Array([20]), s: 'second' });
await p; await wait(20);
// a post while the module is busy/not parked is queued
bridge.post({ type: 'stop' });
const rc = await main;
console.log(`R main returned ${rc} after ${(performance.now() - t0).toFixed(0)} ms; posted ${bridge.stats.posted}, sent ${bridge.stats.sent}, parked ${bridge.stats.parked}`);
console.log('stats', JSON.stringify(bridge.stats), 'pending', bridge.pending());
jt.shutdown();
