// node | bun   run.mjs MODULE.wasm MODE(jspi|sync|import|none) WORKDIR
// Starts server.mjs in a child process, runs the module's `main` on node:wasi (Node's or Bun's) with the
// WasmHost adapter (or without it: MODE none), prints the module's output and checks the
// downloaded file against the server's bytes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WASI } from 'node:wasi';
import { wasiImportObject, wasiInitialize, jspiGap } from '../../js/node/wasi.mjs';
import { wrapWasi } from '../../js/node/spool.mjs';
import { makeImports } from '../../js/node/imports.mjs';

const [wasmPath, mode, work] = process.argv.slice(2);
// (a mode that suspends, on an engine without JSPI: exit 77 with the gap named; e2e.jl reports a skip)
if ((mode === 'jspi' || mode === 'import') && jspiGap()) { console.log(`SKIP: ${jspiGap()}`); process.exit(77); }
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(work, 'out'), { recursive: true });

const server = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { const m = /listening (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
  server.on('exit', (c) => reject(new Error('server exited ' + c)));
});

try {
  const preopens = { [work]: work };
  const env = { FETCH_BASE: `http://127.0.0.1:${port}`, FETCH_OUT: path.join(work, 'out'), PWD: work };
  if (mode !== 'none') { env.WASMHOST_SPOOL = path.join(work, '.wasmhost'); fs.mkdirSync(env.WASMHOST_SPOOL, { recursive: true }); }
  const wasi = new WASI({ version: 'preview1', args: ['fetch'], env, preopens, returnOnExit: true });
  let imports = wasiImportObject(wasi);
  let adapter = null;
  if (mode === 'import') {
    adapter = makeImports({ preopens });
    imports = { ...imports, ...adapter.imports };
  } else if (mode !== 'none') {
    adapter = wrapWasi(imports.wasi_snapshot_preview1, { preopens, spool: env.WASMHOST_SPOOL, mode });
    imports = { ...imports, wasi_snapshot_preview1: adapter.wasiImport };
  }
  const mod = new WebAssembly.Module(fs.readFileSync(wasmPath));
  console.error('imports:', [...new Set(WebAssembly.Module.imports(mod).map((i) => i.module))].join(', '));
  const inst = await WebAssembly.instantiate(mod, imports);
  adapter?.bindMemory(inst.exports.memory);
  wasiInitialize(wasi, inst);
  const t0 = performance.now();
  const rc = mode === 'jspi' || mode === 'import' ? await WebAssembly.promising(inst.exports.main)() : inst.exports.main();
  console.error(`main returned ${rc} in ${(performance.now() - t0).toFixed(0)} ms; host requests: ${adapter?.stats.requests ?? 0}`);
  const blob = path.join(work, 'out', 'blob.bin');
  if (fs.existsSync(blob)) {
    const b = fs.readFileSync(blob);
    const want = await (await fetch(`http://127.0.0.1:${port}/blob.bin`)).arrayBuffer();
    console.error(`blob.bin: ${b.length} bytes, sha256 ${crypto.createHash('sha256').update(b).digest('hex')}, ` +
                  `identical to the server's: ${Buffer.compare(b, Buffer.from(want)) === 0}`);
  }
  const left = fs.existsSync(env.WASMHOST_SPOOL ?? '/nonexistent') ? fs.readdirSync(env.WASMHOST_SPOOL) : [];
  console.error('spool files left:', left.length);
} finally {
  server.kill();
}
