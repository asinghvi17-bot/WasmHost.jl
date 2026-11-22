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
| `common/` | (bundled into each) | any | protocol `wasm-fetch 1`, libcurl's error codes | protocol `wasm-decompress 1`, magic bytes | merging, checking, `WASMHOST_PLATFORM` | – | through Node |
| `node/` | `@wasmhost/node` | Node 24+ and Bun 1.4+ (`node:wasi`) | spool: `spool.mjs`; import: `imports.mjs` | spool: gzip, deflate, zstd (`node:zlib`) | `platform.mjs` (arch, os, libc) | JSPI; sync worker + `Atomics.wait` (spool) | **yes**, end to end against native |
| `browser/` | `@wasmhost/browser` | browsers with JSPI (Chrome/Edge 137+), on `@bjorn3/browser_wasi_shim` | import: `imports.mjs`; spool: later | none yet | none to detect | JSPI; one call at a time (`promisingExports`) | **yes**, import, end to end against native in headless Chromium |
| `workerd/` | – | Cloudflare workerd | import | `DecompressionStream` | – | JSPI if available | **no**: notes |
| `wasmtime/` | – | wasmtime | import, from an embedding | the embedding's | the embedding's | the embedding's | **no**: notes |

**Before publishing:** `node/` imports `../common/` by relative path, so that the repository
works without an install step. A publish bundles `common/` into each package (or publishes it
as a package of its own). Publish only once a second host is tested; until then, use `js/` from
the repository.

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
- `makeImports({ preopens })` is the import transport's `{ wasm_host: { http_request } }`.
