// node mrun.mjs MODULE.wasm WORKDIR WASMCODEGEN
// mprog.jl's module on node:wasi with the bridge: the page posts WGLMakie-style events (mdrive.mjs), the module's
// `events(scene)` handlers run in Wasm, and the evaljs-style messages it sends run here with `new Function`.
import fs from 'node:fs';
import path from 'node:path';
import { WASI } from 'node:wasi';
import { wasiImportObject, wasiInitialize, jspiGap } from '../../js/node/wasi.mjs';
import { wrapWasi } from '../../js/node/spool.mjs';
import { makeBridge } from '../../js/common/bridge.mjs';
import { drive } from './mdrive.mjs';

const [wasmPath, work_, wcg] = process.argv.slice(2);
let commId = null;
const work = path.resolve(work_);
if (jspiGap()) { console.log(`SKIP: ${jspiGap()}`); process.exit(77); }
fs.rmSync(work, { recursive: true, force: true });
const spool = path.join(work, '.wasmhost');
fs.mkdirSync(spool, { recursive: true });
const mod = new WebAssembly.Module(fs.readFileSync(wasmPath));
const io = await import(path.join(wcg, 'js', 'julia_io.mjs'));
const { makeJuliaTask } = await import(path.join(wcg, 'js', 'julia_task.mjs'));
const events = io.makeJuliaIOEvents();
const paths = io.makeJuliaIOPaths({ preopens: [work] });
const jt = makeJuliaTask({ events, onDeadlock: () => console.log('DEADLOCK') });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f) => { for (let i = 0; i < 2000 && !f(); i++) await wait(5); if (!f()) throw new Error('timeout'); };

const bridge = makeBridge({ events, onMessage: (v) => {
  if (v.msg_type === '2') {   // Bonito's EvalJavascript: the source runs in the page
    const log = (...a) => console.log('JS', ...a);
    new Function('console', 'Bonito', v.payload.source)({ log }, {});
  } else { if (v.msg_type === 'hello') commId = v.comm; console.log('R', JSON.stringify(v)); }
} });
const wasi = new WASI({ version: 'preview1', args: ['mprog'], env: { PWD: work, WASMHOST_SPOOL: spool }, preopens: { [work]: work }, returnOnExit: true });
const host = wrapWasi(wasiImportObject(wasi).wasi_snapshot_preview1, { preopens: { [work]: work }, spool, mode: 'jspi', events, bridge });
const inst = await WebAssembly.instantiate(mod, { ...wasiImportObject(wasi), wasi_snapshot_preview1: host.wasiImport,
  julia_io: { ...paths.imports, ...events.imports }, ...jt.imports });
host.bindMemory(inst.exports.memory); events.bindMemory(inst.exports.memory); paths.bindMemory(inst.exports.memory);
wasiInitialize(wasi, inst);
jt.bind(inst);

const main = jt.call(inst.exports.main);
main.catch((e) => console.log('main rejected', e));
await until(() => commId !== null);
await drive({ bridge, commId, wait, until });
const rc = await main;
console.log(`main returned ${rc}; bridge ${JSON.stringify(bridge.stats)}`);
jt.shutdown();
