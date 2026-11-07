# `@wasmhost/browser`: browser adapter

WasmHost's host side in a browser: the downloads of a module (both transports, spool and
import) with the page's `fetch`, and its decompression with `DecompressionStream`. The module runs
on [`@bjorn3/browser_wasi_shim`](https://github.com/bjorn3/browser_wasi_shim), whose in-memory
filesystem holds the spool directory and the bodies. No `node:` module, and no import but
`../common/`: the adapter uses the shim's WASI instance it is given, so the page chooses the
shim's version (tested: 0.4.2).

**Tested** end to end in headless Chromium 158 (Playwright), against native, in CI:
`test/e2e/e2e.jl` with `WASM_RUNTIME=chromium` (see [Testing](#testing)).

## Use

```js
import { WASI, File, OpenFile, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
import { wrapWasi, makeImports, jspiGap } from './WasmHost.jl/js/browser/index.mjs';

if (jspiGap()) throw new Error(jspiGap());                  // no JSPI: e.g. Firefox, Safari
const root = new PreopenDirectory('/work', new Map());      // the module's filesystem, in memory
const wasi = new WASI(['main'], ['WASMHOST_SPOOL=/work/.wasmhost', 'PWD=/work'], [
  new OpenFile(new File([])), ConsoleStdout.lineBuffered(console.log), ConsoleStdout.lineBuffered(console.warn), root]);

// spool transport (downloads and decompression):
const host = wrapWasi(wasi, { spool: '/work/.wasmhost' });
const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: host.wasiImport });
// import transport (a module built with WasmHost.transport() = :import):
//   const host = makeImports({ wasi, spool: '/work/.wasmhost' });
//   const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport, ...host.imports });
host.bindMemory(inst.exports.memory);
wasi.initialize(inst);
await WebAssembly.promising(inst.exports.main)();
```

- `wrapWasi(wasi, { spool, fetchImpl, wasiImport })`: wraps the shim's `path_open`, as
  `../node/spool.mjs` does Node's: opening `<spool>/<id>.res` performs `<spool>/<id>.req`,
  opening `<spool>/<id>.dres` decompresses as `<spool>/<id>.dreq` asks. `wasiImport` replaces
  `wasi.wasiImport` (e.g. one wrapped already).
- `makeImports({ wasi, spool, fetchImpl })`: `{ wasm_host: { http_request } }`. The spool
  directory is still needed: request bodies from, and responses into, an `IO` go through files
  in it. Decompression always uses the spool transport: give such a module `wrapWasi`'s
  `wasiImport` too.
- The shim's import map entry, or a bundler, resolves `@bjorn3/browser_wasi_shim` for the page;
  the adapter itself imports only `../common/` by relative path (see `js/README.md` on
  publishing).
- `makeShimFs(wasi)` is the adapter's view of the shim's preopens (read and write a file by
  guest path), for a page that puts inputs in or takes results out.

## Requirements and limits

- **JSPI:** Chrome and Edge 137+, where it is on by default. Not in Firefox or Safari at the
  time of writing: `wrapWasi` and `makeImports` throw, and `jspiGap()` says why. Exports that
  download or decompress are called through `WebAssembly.promising`. There is no `sync` mode: a
  page's main thread can't block. (A Worker could, with `SharedArrayBuffer` under cross-origin
  isolation and a second worker for `fetch`; not written.)
- **One request in flight per module:** the module is suspended while the host works, and
  Julia's runtime isn't re-entrant. Don't call the module's exports again until the promise of
  the suspended one settles: a second job of the same instance while one is in flight fails
  (code 2, or `EIO` for decompression) with the message
  `another request of this module is in flight`.
- **User-Agent:** a browser sends its own. Chromium ignores the program's `User-Agent`,
  Downloads' default one included; Firefox would send it. Servers that require a particular
  User-Agent (e.g. tile servers' usage policies) see the browser's.
- **CORS:** the module's requests are the page's. A cross-origin server must allow the page's
  origin (`Access-Control-Allow-Origin`). Request headers other than CORS-safelisted ones (any
  custom header, such as `X-Probe` or an `Authorization`) need a preflight that the server
  answers with `Access-Control-Allow-Headers`. The module sees only the CORS-safelisted response
  headers and those the server lists in `Access-Control-Expose-Headers`. A CORS refusal looks
  like a network failure to the page: libcurl's code 7.
- **Other request headers:** the browser drops the Fetch standard's forbidden ones
  (`Accept-Encoding`, `Cookie`, `Host`, `Content-Length`, ...) and decodes compressed responses
  itself. `set-cookie` is never visible.
- **Errors:** the browser gives one `TypeError` without detail for every network failure
  (refused, unresolved, TLS, CORS, too many redirects): all are code 7. A timeout is 28.
- **Memory:** bodies are whole `Uint8Array`s, in the shim's filesystem and while in flight.
- **Decompression:** gzip and deflate (the zlib format); zstd only where the browser's
  `DecompressionStream` has it (not Chromium 158): else `ENOSYS` (52), as for bzip2, xz and lz4.
- **Platform tags:** a page has none of its own to detect for binaries: `WASMHOST_PLATFORM` is
  whatever the page sets in the WASI environment, if anything.

## Testing

`test/e2e/e2e.jl` with `WASM_RUNTIME=chromium` (CI job `e2e … chromium`):

```
cd test/e2e/browser && npm ci && npx playwright install chromium && cd -
WASM_RUNTIME=chromium julia test/e2e/e2e.jl /path/to/WasmCodegen.jl all
```

- **spool, import:** `test/e2e/prog.jl`, compiled by WasmCodegen, in Playwright's headless
  Chromium (`browser/run.mjs`). The page and the module come from one local origin; the test
  resources (`server.mjs`) from another, with CORS. The output and the downloaded 3 MiB file
  must equal the native program's, byte for byte, except the User-Agent the server echoes back
  (T3), which must be the browser's.
- **decompress:** `browser/decompress.mjs`, the adapter alone in Chromium: gzip, deflate and
  zstd made by `node:zlib` must decompress to the original bytes (or zstd `ENOSYS`), and the
  error cases must give WasmHost.Decompress's errnos. (`test/e2e/dprog.jl` needs WasmCodegen's
  `julia_regex`, which isn't run in CI on any runtime.)
