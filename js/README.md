# Host adapters

The Julia side of WasmHost is host-agnostic: its modules and the protocols don't know which
runtime they run on. A build only chooses the **transport** of its downloads:
- **spool:** files of a spool directory over the WASI filesystem. Decompression always uses it.
- **import:** the import library `wasm_host`, which needs `Config(import_libraries)`
  ([gbaraldi/WasmCodegen.jl#57](https://github.com/gbaraldi/WasmCodegen.jl/pull/57), merged).

Page messages (`WasmHost.Page`, the import library `wasm_host_page`) need neither: only the
module's memory. Their host side is `common/page.mjs` (`makePage`), the same for every host,
which `node/page.mjs` and `browser/page.mjs` re-export.

There is one adapter per host family, laid out as a future npm package with its own
`package.json` (`"private": true`: nothing is published yet). They share the host-independent
code in `common/`.

| Directory | Future package | Host | Downloads | Decompression | Platform tags | Waiting | Tested? |
|---|---|---|---|---|---|---|---|
| `common/` | (bundled into each) | any | protocol `wasm-fetch 1`, libcurl's error codes | protocol `wasm-decompress 1`, magic bytes | merging, checking, `WASMHOST_PLATFORM` | – | through Node and Chromium |
| `node/` | `@wasmhost/node` | Node 24+ and Bun 1.4+ (`node:wasi`) | spool: `spool.mjs`; import: `imports.mjs` | spool: gzip, deflate, zstd (`node:zlib`) | `platform.mjs` (arch, os, libc) | JSPI; sync worker + `Atomics.wait` (spool) | **yes**, end to end against native |
| `browser/` | `@wasmhost/browser` | browsers with JSPI (Chrome/Edge 137+), on `@bjorn3/browser_wasi_shim` | spool: `spool.mjs`; import: `imports.mjs` (bodies in the shim's in-memory filesystem) | spool: `DecompressionStream`: gzip, deflate; zstd where the browser has it (not Chromium 158) | none to detect | JSPI only; one call at a time per module (`promisingExports`); a re-entrant call poisons the instance (make a new one) | **yes**, end to end against native in headless Chromium 158 (Playwright); decompression: the adapter alone |
| `workerd/` | – | Cloudflare workerd | import | `DecompressionStream` | – | JSPI if available | **no**: notes |
| `wasmtime/` | – | wasmtime | import, from an embedding | the embedding's | the embedding's | the embedding's | **no**: notes |

**Before publishing:** `node/` and `browser/` import `../common/` by relative path, so that the
repository works without an install step (and, for `browser/`, without an import map entry of
its own). A publish bundles `common/` into each package (or publishes it as a package of its
own). A second host (Chromium) is now tested; until a publish, use `js/` from the repository.

## Node (`@wasmhost/node`)

```js
import { WASI } from 'node:wasi';
import { wrapWasi, platformEnv, wasiInitialize } from './WasmHost.jl/js/node/index.mjs';

const work = '/abs/work';                           // preopened at the same path
const spool = `${work}/.wasmhost`;
const wasi = new WASI({ version: 'preview1', preopens: { [work]: work },
                        env: { WASMHOST_SPOOL: spool, PWD: work, ...platformEnv() } });
const host = wrapWasi(wasi.wasiImport, { preopens: { [work]: work }, spool, mode: 'jspi' });
const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: host.wasiImport });
host.bindMemory(inst.exports.memory);
wasiInitialize(wasi, inst);                         // wasi.initialize(inst) on Node; Bun's node:wasi has none
await WebAssembly.promising(inst.exports.main)();   // mode 'sync': inst.exports.main()
```

- **Bun:** the same adapter runs in Bun 1.4 (JavaScriptCore). Its `node:wasi` has `wasiImport` but no
  `getImportObject()` or `initialize()`; `wasiImportObject(wasi)` and `wasiInitialize(wasi, instance)` (`wasi.mjs`)
  work in both. JSPI is on by default in Bun 1.4; `jspiGap()` names it where an engine lacks it. The tests take
  `WASM_RUNTIME=node|bun` (`test/runtests.jl`, `test/e2e/e2e.jl`).

- `wrapWasi` serves downloads (`.res`) and decompression (`.dres`) from one `path_open`
  wrapper: a `WebAssembly.Suspending` can't be wrapped twice.
- `platformEnv(overrides)` is `{ WASMHOST_PLATFORM: "arch=…;os=…;libc=…" }`, the detected tags
  with `overrides` (an object) applied key by key.
- `makeImports({ preopens, events })` is the import transport's `{ wasm_host: { http_request,
  http_start, http_finish, http_batch, http_batch_result } }`.
- **Concurrent requests** (a module with Julia tasks, `Config(tasks = :jspi)`): pass the
  `julia_io` events the module runs on, WasmCodegen's `makeJuliaIOEvents()`, as `events` to
  `wrapWasi` (mode `'jspi'`) or `makeImports`. A request then starts without suspending the
  module and returns an external `julia_io` handle (`events.external()`), ready when the
  response is there (`http_start(req, req_len, body, body_len)`: `body_len` -1, or absent, no
  body; else the request's body, copied at once): the module's task waits for it alone, its other tasks run, and their
  requests overlap. Run the module's exports through WasmCodegen's julia_task (`jt.call`).
  Batches of requests (`WasmHost.Downloads.request_all`) need nothing: both transports and both
  spool modes perform a batch's requests together.

## Browser (`@wasmhost/browser`)

```js
import { WASI, File, OpenFile, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
import { wrapWasi, makeImports, promisingExports } from './WasmHost.jl/js/browser/index.mjs';

const root = new PreopenDirectory('/work', new Map());
const wasi = new WASI(['main'], ['WASMHOST_SPOOL=/work/.wasmhost', 'PWD=/work'],
                      [new OpenFile(new File([])), ConsoleStdout.lineBuffered(console.log), ConsoleStdout.lineBuffered(console.warn), root]);
// spool transport:
const host = wrapWasi(wasi, { spool: '/work/.wasmhost' });
const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: host.wasiImport });
// import transport (makeImports returns { imports, bindMemory, stats }):
//   const host = makeImports({ wasi, spool: '/work/.wasmhost' });
//   const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport, ...host.imports });
host.bindMemory(inst.exports.memory);
wasi.initialize(inst);
await promisingExports(inst).main();                 // one call at a time per module
```

- Takes the shim's WASI instance rather than Node's `preopens`: the shim's preopens and its
  in-memory files are the module's filesystem, which the adapter reads and writes through the
  shim's own directory operations (no import of the shim).
- Concurrent requests as in Node (`events`); the module's other `julia_io` imports are
  WasmCodegen's events (they load in browsers) and `makeShimJuliaIOPaths(wasi)` (file modes on
  the shim); call its exports through `promisingExports(inst, { tasks: jt })`.
- Needs JSPI (Chrome/Edge 137+); one call at a time per module (`promisingExports`; a re-entrant call poisons the instance); the
  browser's User-Agent replaces the program's; CORS applies; no credentials by default. See [`browser/README.md`](browser/README.md).
