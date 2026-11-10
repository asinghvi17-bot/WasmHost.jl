// node brun.mjs MODULE.wasm WORKDIR WASMCODEGEN CASE
// brprog.jl's module (Julia tasks, WasmHost.Bridge) on node:wasi with the Node adapter's bridge: the page's side of
// CASE (bdrive.mjs) posts while `main` is in flight and parked in `recv`, answers the module's asks, closes, and
// checks what the module sent, printed (its stdout, a file here) and returned. Prints "bridge: WHAT: true|false" per
// check and "BRIDGE PASS" or "BRIDGE FAIL" (exit status 1); exits 77 and prints "SKIP: ..." without JSPI.
import fs from 'node:fs';
import path from 'node:path';
import { WASI } from 'node:wasi';
import { wasiImportObject, wasiInitialize, jspiGap } from '../../js/node/wasi.mjs';
import { wrapWasi } from '../../js/node/spool.mjs';
import { makeBridge } from '../../js/common/bridge.mjs';
import { bridgeScenario } from './bdrive.mjs';

const [wasmPath, work_, wcg_, which] = process.argv.slice(2);
const wcg = path.resolve(wcg_);
const work = path.resolve(work_);
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
const jt = makeJuliaTask({ events, onDeadlock: () => console.log('DEADLOCK') });
const s = bridgeScenario(makeBridge, events, which);

const wasi = new WASI({ version: 'preview1', args: ['brprog'], env: { PWD: work, WASMHOST_SPOOL: spool, BRIDGE_CASE: which },
                        preopens: { [work]: work }, stdout: outFd, returnOnExit: true });
const host = wrapWasi(wasiImportObject(wasi).wasi_snapshot_preview1, { preopens: { [work]: work }, spool, mode: 'jspi', events, bridge: s.bridge });
const inst = await WebAssembly.instantiate(mod, { ...wasiImportObject(wasi), wasi_snapshot_preview1: host.wasiImport,
  julia_io: { ...paths.imports, ...events.imports }, ...jt.imports });
host.bindMemory(inst.exports.memory); events.bindMemory(inst.exports.memory); paths.bindMemory(inst.exports.memory);
wasiInitialize(wasi, inst);
jt.bind(inst);

const stdout = () => fs.readFileSync(outFile, 'utf8').split('\n').filter((l) => l.length);
// (write-fails: the adapter's next write of an inbox file throws, as node:fs would)
let failInbox = false;
const writeFileSync = fs.writeFileSync;
fs.writeFileSync = (file, ...rest) => {
  if (failInbox && String(file).endsWith('.inb')) { failInbox = false; throw new Error('injected write failure'); }
  return writeFileSync(file, ...rest);
};
const checks = await s.run({ main: jt.call(inst.exports.main), stdout, failInboxWrite: () => { failInbox = true; } });
for (const l of stdout()) console.log(`stdout: ${l}`);
console.log(`stats: ${JSON.stringify(s.bridge.stats)}`);
for (const [what, ok] of checks) console.log(`bridge: ${what}: ${ok}`);
const pass = checks.length > 0 && checks.every(([, ok]) => ok);
console.log(pass ? 'BRIDGE PASS' : 'BRIDGE FAIL');
console.log(`spool files left: ${fs.readdirSync(spool).length}`);
jt.shutdown();
process.exit(pass ? 0 : 1);
