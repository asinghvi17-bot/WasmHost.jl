// node mrun.mjs MODULE.wasm WORKDIR WASMCODEGEN
// mprog.jl's module on node:wasi with the bridge: the page posts WGLMakie-style events (mdrive.mjs), the module's
// `events(scene)` handlers run in Wasm, and the evaljs-style messages it sends run here with `new Function`. Prints
// the log and "makie: WHAT: true|false" per check (mdrive.mjs's checkMakie), then "MAKIE PASS" or "MAKIE FAIL"
// (exit status 1); exits 77 and prints "SKIP: ..." without JSPI.
import fs from 'node:fs';
import path from 'node:path';
import { WASI } from 'node:wasi';
import { wasiImportObject, wasiInitialize, jspiGap } from '../../js/node/wasi.mjs';
import { wrapWasi } from '../../js/node/spool.mjs';
import { makeBridge } from '../../js/common/bridge.mjs';
import { drive, evalMessage, checkMakie } from './mdrive.mjs';

const [wasmPath, work_, wcg_] = process.argv.slice(2);
const work = path.resolve(work_), wcg = path.resolve(wcg_);
if (jspiGap()) { console.log(`SKIP: ${jspiGap()}`); process.exit(77); }
fs.rmSync(work, { recursive: true, force: true });
const spool = path.join(work, '.wasmhost');
fs.mkdirSync(spool, { recursive: true });
const outFile = path.join(work, 'stdout.txt');
const outFd = fs.openSync(outFile, 'w');
const mod = new WebAssembly.Module(fs.readFileSync(wasmPath));
const io = await import(path.join(wcg, 'js', 'julia_io.mjs'));
const { makeJuliaTask } = await import(path.join(wcg, 'js', 'julia_task.mjs'));
const events = io.makeJuliaIOEvents();
const paths = io.makeJuliaIOPaths({ preopens: [work] });
const log = [];
const jt = makeJuliaTask({ events, onDeadlock: () => log.push('DEADLOCK') });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f) => { for (let i = 0; i < 4000 && !f(); i++) await wait(5); if (!f()) throw new Error('timeout'); };

let commId = null;
const bridge = makeBridge({ events, onMessage: (v) => { if (v.msg_type === 'hello') commId = v.comm; evalMessage(v, bridge, log); } });
const wasi = new WASI({ version: 'preview1', args: ['mprog'], env: { PWD: work, WASMHOST_SPOOL: spool }, preopens: { [work]: work },
                        stdout: outFd, returnOnExit: true });
const host = wrapWasi(wasiImportObject(wasi).wasi_snapshot_preview1, { preopens: { [work]: work }, spool, mode: 'jspi', events, bridge });
const inst = await WebAssembly.instantiate(mod, { ...wasiImportObject(wasi), wasi_snapshot_preview1: host.wasiImport,
  julia_io: { ...paths.imports, ...events.imports }, ...jt.imports });
host.bindMemory(inst.exports.memory); events.bindMemory(inst.exports.memory); paths.bindMemory(inst.exports.memory);
wasiInitialize(wasi, inst);
jt.bind(inst);

let rc, failure = null;
try {
  const main = jt.call(inst.exports.main);
  await until(() => commId !== null);
  await drive({ bridge, commId, until });
  rc = await main;
} catch (e) { failure = e; }
const out = fs.readFileSync(outFile, 'utf8').split('\n').filter((l) => l.length);
for (const l of log) console.log(l);
for (const l of out) console.log(`stdout: ${l}`);
console.log(`main returned ${rc}; bridge ${JSON.stringify(bridge.stats)}`);
const checks = [...checkMakie({ log, out, rc, pos: '12.5,30.0', scroll: '0.0,-1.0' }), [`no failure (${failure?.message ?? ''})`, failure === null]];
for (const [what, ok] of checks) console.log(`makie: ${what}: ${ok}`);
const pass = checks.every(([, ok]) => ok);
console.log(pass ? 'MAKIE PASS' : 'MAKIE FAIL');
jt.shutdown();
process.exit(pass ? 0 : 1);
