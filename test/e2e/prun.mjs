// node | bun   prun.mjs MODULE.wasm wasi|js [JULIA_MJS]
// Runs pprog.jl's module with the page adapter (js/common/page.mjs): a module for WASI on node:wasi
// (`main`: both directions), or one for JavaScript (`host = :js`)
// on WasmCodegen's js/julia.mjs (`main_send`: sending only). Prints the module's output, whether the
// messages it sent are the expected ones (the same check as pnative.jl), and the time of a send.
import fs from 'node:fs';
import { WASI } from 'node:wasi';
import { wasiImportObject, wasiInitialize } from '../../js/node/wasi.mjs';
import { makePage } from '../../js/common/page.mjs';

const [wasmPath, host, juliaMjs] = process.argv.slice(2);
const SIZES = [0, 1, 7, 1024, 65536, 1048577], LENGTHS = [0, 1, 9, 1000, 500000];
const CODEPOINTS = [0x61, 0xe9, 0x3b1, 0x20ac, 0x1f600];
const pattern = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (7 * (i + 1) + seed) & 255);
const text = (n, seed) => Array.from({ length: n }, (_, i) => String.fromCodePoint(CODEPOINTS[(i + 1 + seed) % 5])).join('');
const utf8 = (s) => new TextEncoder().encode(s);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const received = [];
let keep = true;   // (the benchmark's messages are not kept)
const page = makePage({ onMessage: (bytes) => { if (keep) received.push(bytes.slice()); } });
const mod = new WebAssembly.Module(fs.readFileSync(wasmPath));
let exports;
if (host === 'wasi') {
  const wasi = new WASI({ version: 'preview1', args: ['page'], env: {}, preopens: {}, returnOnExit: true });
  const inst = await WebAssembly.instantiate(mod, { ...wasiImportObject(wasi), ...page.imports });
  page.bindMemory(inst.exports.memory);
  wasiInitialize(wasi, inst);
  exports = inst.exports;
} else {
  const { instantiate } = await import(new URL(`file://${juliaMjs}`));
  const { instance } = await instantiate(mod, { imports: page.imports });
  page.bindMemory(instance.exports.memory);
  exports = instance.exports;
}

const posted = [...SIZES.map((n, k) => pattern(n, 100 + k + 1)), ...LENGTHS.map((n, k) => utf8(text(n, 10 + k + 1)))];
const both = host === 'wasi';
if (both) {
  SIZES.forEach((n, k) => page.post(pattern(n, 100 + k + 1)));
  LENGTHS.forEach((n, k) => page.post(text(n, 10 + k + 1)));   // (a string: posted as UTF-8)
  exports.main();
} else {
  exports.main_send();
}
const expected = [...SIZES.map((n, k) => pattern(n, k + 1)), ...LENGTHS.map((n, k) => utf8(text(n, k + 1))), ...(both ? posted : [])];
const ok = received.length === expected.length && received.every((m, i) => same(m, expected[i])) &&
           page.queued() === 0 && (!both || page.stats.received === posted.length);
console.log(`page check: ${ok} (${received.length} messages)`);
if (!ok) for (let i = 0; i < Math.max(received.length, expected.length); i++)
  if (!received[i] || !expected[i] || !same(received[i], expected[i]))
    console.log(`  message ${i + 1}: ${received[i]?.length ?? 'none'} bytes, expected ${expected[i]?.length ?? 'none'}`);

// the time of a send, after warming up
keep = false;
for (const n of [1024, 65536]) {
  exports.bench_message(n);
  const reps = n === 1024 ? 20000 : 500;
  for (let r = 0; r < reps / 10; r++) exports.bench_send();
  const t0 = performance.now();
  for (let r = 0; r < reps; r++) exports.bench_send();
  console.log(`B send ${n} bytes (${host}): ${((performance.now() - t0) / reps * 1000).toFixed(2)} µs`);
}
