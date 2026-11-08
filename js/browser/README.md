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
import { wrapWasi, makeImports, promisingExports, jspiGap } from './WasmHost.jl/js/browser/index.mjs';

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
const exports = promisingExports(inst);                     // every call into the module goes through these
await exports.main();
```

- `promisingExports(instance, { whenBusy, tasks })`: the instance's function exports, each through
  `WebAssembly.promising` (so each returns a promise; with `tasks`, a module with Julia tasks,
  through WasmCodegen's julia_task `tasks.call`, and without `jl_task_entry`), one call at a time: a call made while
  another is in flight waits for it to settle (`whenBusy: 'queue'`, the default) or is rejected
  with a `ReentryError` (`'reject'`). Call the module only through these (see
  [one call at a time](#requirements-and-limits)).
- `wrapWasi(wasi, { spool, fetchImpl, credentials, wasiImport })`: wraps the shim's `path_open`, as
  `../node/spool.mjs` does Node's: opening `<spool>/<id>.res` performs `<spool>/<id>.req`,
  opening `<spool>/<id>.dres` decompresses as `<spool>/<id>.dreq` asks. `wasiImport` replaces
  `wasi.wasiImport` (e.g. one wrapped already).
- `makeImports({ wasi, spool, fetchImpl, credentials })`: `{ imports: { wasm_host: { http_request } }, bindMemory, stats }`. The spool
  directory is still needed: request bodies from, and responses into, an `IO` go through files
  in it. Decompression always uses the spool transport: give such a module `wrapWasi`'s
  `wasiImport` too.
- The shim's import map entry, or a bundler, resolves `@bjorn3/browser_wasi_shim` for the page;
  the adapter itself imports only `../common/` by relative path (see `js/README.md` on
  publishing).
- `credentials` is `fetch`'s, `'omit'` by default: the page's cookies and HTTP authentication
  don't go with the program's requests, as natively libcurl has neither. Pass `'same-origin'` or
  `'include'` to send them (a cross-origin server must then name the origin and allow
  credentials).
- **A module with Julia tasks** (`Config(tasks = :jspi)`): its requests overlap when the
  adapter has the module's `julia_io` events:

  ```js
  const { makeJuliaIOEvents } = await import('./WasmCodegen.jl/js/julia_io.mjs');
  const { makeJuliaTask } = await import('./WasmCodegen.jl/js/julia_task.mjs');
  const events = makeJuliaIOEvents(), paths = makeShimJuliaIOPaths(wasi);
  const jt = makeJuliaTask({ events, keepAlive: false });
  const host = wrapWasi(wasi, { spool: '/work/.wasmhost', events });      // or makeImports({ ..., events })
  const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: host.wasiImport,
    julia_io: { ...paths.imports, ...events.imports }, ...jt.imports });
  host.bindMemory(inst.exports.memory); events.bindMemory(inst.exports.memory); paths.bindMemory(inst.exports.memory);
  wasi.initialize(inst); jt.bind(inst);
  await promisingExports(inst, { tasks: jt }).main();
  ```

  A request starts without suspending (`<id>.hnd`, `wasm_host.http_start`); the task waits for
  its `julia_io` handle while the others run. The re-entry guard then refuses a start, or a
  suspending job, while the module is suspended in a job or in julia_io's `poll`
  (`notSuspended`, `oneAtATime(wasi, events)`); starts of the running call's tasks overlap
  freely. The browser opens at most 6 connections per host for HTTP/1.1, so more requests to
  one host than that overlap in rounds.
- `makeShimJuliaIOPaths(wasi)`: `julia_io`'s `path_mode`, `path_chmod`, `path_symlink` on the
  shim (no permission bits, no links: a file is 0o100644, a directory 0o040755; chmod and
  symlink answer ENOSYS, julia_io's "no modes", so a mode asked of mkdir or open is not an
  error), which a module built with `host_extensions = [:julia_io]` imports; WasmCodegen's own are Node's.
- `makeShimFs(wasi)` is the adapter's view of the shim's preopens (read and write a file by
  guest path), for a page that puts inputs in or takes results out.

## Requirements and limits

- **JSPI:** Chrome and Edge 137+, where it is on by default. Not in Firefox or Safari at the
  time of writing: `wrapWasi` and `makeImports` throw, and `jspiGap()` says why. Exports that
  download or decompress are called through `WebAssembly.promising` (`promisingExports`). There
  is no `sync` mode: a
  page's main thread can't block. (A Worker could, with `SharedArrayBuffer` under cross-origin
  isolation and a second worker for `fetch`; not written.)
- **One call at a time per module:** the module is suspended in the middle of an export while
  the host works, and the page's event loop runs on, but Julia's runtime isn't re-entrant: no
  call may enter the module, on any export, until the suspended export's promise settles. Call
  the module only through `promisingExports(instance)`, which keeps to this (queueing or
  rejecting). A page that calls `instance.exports` directly in the meantime runs Julia code
  re-entrantly, which nothing can make safe; the adapter catches it at the latest when that call
  needs the host (a download or a decompression while another is in flight): it throws a
  `ReentryError` into the module, which unwinds the re-entrant call (WasmCodegen's handlers
  catch only Julia's own exceptions) and rejects its promise.
- **User-Agent:** the browser's, not the program's. The Fetch standard no longer forbids
  setting `User-Agent`, but Chromium drops it silently from `fetch` requests
  ([crbug 571722](https://crbug.com/571722)), Downloads' default one included; the e2e checks
  that Chromium sends its own. Servers that require a particular User-Agent (e.g. tile servers'
  usage policies) see the browser's.
- **CORS:** the module's requests are the page's. A cross-origin server must allow the page's
  origin (`Access-Control-Allow-Origin`). Request headers other than CORS-safelisted ones (any
  custom header, such as `X-Probe` or an `Authorization`) need a preflight that the server
  answers with `Access-Control-Allow-Headers`. The module sees only the CORS-safelisted response
  headers and those the server lists in `Access-Control-Expose-Headers`. A CORS refusal looks
  like a network failure to the page: libcurl's code 7. Requests carry no credentials unless
  `credentials` says so.
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
  (T3), which must be the browser's. Then `main` is called twice at once through
  `promisingExports`: queued, both runs must equal native's, one after the other; with
  `whenBusy: 'reject'`, the second must be a `ReentryError` and the first equal native's. The
  adapter's host guard is checked on its own too (a second job of an instance is a
  `ReentryError` until the first settles; other instances are not blocked).
- **decompress:** `browser/decompress.mjs`, the adapter alone in Chromium: gzip, deflate and
  zstd made by `node:zlib` must decompress to the original bytes (or zstd `ENOSYS`), and the
  error cases must give WasmHost.Decompress's errnos. (`test/e2e/dprog.jl` needs WasmCodegen's
  `julia_regex`, which isn't run in CI on any runtime.)
