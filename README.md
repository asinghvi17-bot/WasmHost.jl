# WasmHost.jl

Host capabilities for Julia programs compiled to WebAssembly by
[WasmCodegen.jl](https://github.com/gbaraldi/WasmCodegen.jl): what a WASI host doesn't provide,
performed by the JavaScript host around the module. Natively nothing changes.

| Module | What | How the program uses it |
|---|---|---|
| `WasmHost.Downloads` | HTTP requests with the host's `fetch` (TLS, redirects and proxies are the host's) | plain `Downloads.download` / `Downloads.request`, through the package extension |
| `WasmHost.Decompress` | gzip, deflate and zstd decompression of a file by the host | `WasmHost.Decompress.decompress(src, dst)` |
| `WasmHost.Platform` | the host's platform tags (arch, os, libc, ...) from the WASI environment | `WasmHost.Platform.host_platform()` |
| `WasmHost.Page` | messages (bytes) between the program and the JavaScript around it: a page, a worker, a Node script | `WasmHost.Page.send(bytes)`, `receive()`, `poll(f)`, through the package extension |

```julia
using Downloads
f() = String(take!(Downloads.download("https://example.org/data.csv", IOBuffer())))
```

**Status:** an early release. Tested end to end against native on **Node** and **Bun** (CI)
and in **Chromium** (headless, Playwright), with both transports, spool and import. Other hosts
are designed but untested; see [Hosts](#hosts).

WasmHost.jl was called WasmFetch.jl until it gained decompression and platform tags. Same UUID.

## How it works

- **Julia, host-agnostic.** The modules don't know which host they run on; a build only
  chooses the transport of its downloads.
- **The spool transport (the default; works today).** Files of a spool directory inside a WASI
  preopen, `ENV["WASMHOST_SPOOL"]` (the older `WASM_FETCH_SPOOL` is accepted too). The module
  writes a request, `<spool>/<id>.req` (or `.dreq` for decompression), and opens the response,
  `<spool>/<id>.res` (`.dres`). The host adapter wraps the module's WASI `path_open`: opening
  a pending response does the work first. The module imports only `wasi_snapshot_preview1`.
  The protocols, `wasm-fetch 1` and `wasm-decompress 1`, are documented in `src/downloads.jl`
  and `src/decompress.jl`.
- **The import transport.** A `wasm_host.http_request` import, for downloads only. It needs
  WasmCodegen to let a program declare an import library of its own,
  `Config(import_libraries = ["wasm_host"])`
  ([gbaraldi/WasmCodegen.jl#57](https://github.com/gbaraldi/WasmCodegen.jl/pull/57), merged on
  2026-11-05). It also uses WasmCodegen's staging area of the linear memory
  (`Runtime.Staging`) to pass the request and response text. CI's end-to-end test runs it
  against the WasmCodegen commit the workflow pins.
- **Waiting.** The host's work is asynchronous, and the adapter waits in one of two ways:
  - **`jspi`:** the intercepted `path_open`, or `wasm_host.http_request`, is a
    `WebAssembly.Suspending`, so the module is suspended while the host works. Call the export
    through `WebAssembly.promising`.
  - **`sync`:** the work runs on a worker thread while the main thread blocks in
    `Atomics.wait`. Spool transport only, not in browsers: they wait with JSPI only.

## Downloads

A package extension, `WasmHostDownloadsExt`, is loaded when Downloads and WasmCodegen are both
loaded. It adds methods to WasmCodegen's overlay method table
`WasmCodegen.Runtime.WASM_METHODS` for `Downloads.request`, `Downloads.Curl.status_ok` and
`Downloads.get_ca_roots`. WasmCodegen compiles them in place of the native methods, so the
module contains no libcurl. `Downloads.download` is Downloads' own and calls `request`.

### What is supported (Node, spool transport)

| | |
|---|---|
| **Methods and bodies** | GET, HEAD, PUT, POST and other methods. Bodies to a path, an `IO` or nowhere; request bodies from a path or an `IO`. A path body is streamed to the file by the host. |
| **Headers** | Request headers, including Downloads' default `User-Agent`. The response's headers with lower-case names, `set-cookie` entries kept apart. |
| **Redirects** | Followed. `Response.url` is the final URL. |
| **Errors** | A non-2xx `download` is a `RequestError` with code 0 and the response. A transport failure is a `RequestError` with libcurl's code (6 resolve, 7 connect, 28 timeout, 47 too many redirects, 60 TLS, else 56) and status 0. `request(throw = false)` returns it. |
| **Progress** | One call at the end with the complete transfer: `(Content-Length or 0, bytes received)`, as libcurl's last call. |
| **`Downloader`** | Accepted. Its `easy_hook` and the `verbose`, `debug` and `interrupt` options have no effect, since there is no libcurl. |

### Known differences from libcurl

- **Status line:** it is always `HTTP/1.1 <code> <text>`. `fetch` doesn't expose the HTTP
  version, so against an HTTP/2 server native Downloads says `HTTP/2 200`.
- **Error messages:** they are `fetch`'s, not curl's. The error codes are mapped to libcurl's.
- **Blocked ports:** `fetch` refuses the ports of the Fetch standard's "bad port" list (e.g. 9,
  25, 6000), which libcurl would connect to. These are reported as code 7.
- **Content-Encoding:** `fetch` decodes a compressed response (gzip, deflate, br and, in newer
  runtimes, zstd) itself, and browsers don't let a program set `Accept-Encoding`. libcurl, as
  Downloads uses it, writes the raw bytes.
- **Redirect limit:** `fetch`'s is 20, where Downloads asks libcurl for 50.

### Concurrent requests

Requests written as ordinary Julia overlap, as they do natively:

```julia
@sync for (url, io) in zip(urls, ios)
    @async Downloads.request(url; output = io)
end
paths = asyncmap(url -> Downloads.download(url, joinpath(dir, basename(url))), urls)
t = @async Downloads.download(url, IOBuffer()); ...; body = take!(fetch(t)::IOBuffer)
```

- **With Julia tasks** (`WasmCodegen.Config(tasks = :jspi, host_extensions = [:julia_io])`):
  each `Downloads.request` is started by the host, which returns at once with a handle of
  WasmCodegen's `julia_io` events (spool: opening `<id>.hnd`; import: `wasm_host.http_start`).
  The task waits for that handle as it waits for a `Timer` (`Runtime.Host.await_handle`): it
  is parked in the scheduler, the other tasks run, and the module suspends (JSPI) only when
  every task waits, until any of their handles is ready (one `julia_io.poll` over all of them).
  The host side: give the adapter the same `julia_io` events the module runs on
  (`wrapWasi(..., { events })`, `makeImports({ events })`, in Node and in the browser). Without
  them each request waits as before, suspending the whole module. Needs a WasmCodegen whose
  `julia_io.mjs` has external handles (`events.external`) and with `Runtime.Tasks.enabled()`.
  `asyncmap` compiles with that WasmCodegen too (its task patches type Base's).
- **In a program of one task** (`tasks = :none`, where `@async` can't wait):
  `WasmHost.Downloads.request_all(urls; outputs, bodies, method, headers, timeout, throw)` hands
  the host all the requests at once (`wasm-fetch-batch 1`: `<id>.breq`/`<id>.bres`, or
  `wasm_host.http_batch`), which it performs together; one wait for all. Natively (with
  Downloads loaded, `WasmHostRequestAllExt`) it is `asyncmap` over `Downloads.request`, so the
  program runs the same natively. (In a module with tasks it is concurrent requests.)
  `bodies[i]` (a `Vector{UInt8}`, a `String` or `nothing`) is the request body of `urls[i]`
  (in a module with tasks and the import transport, given inline to `wasm_host.http_start`;
  otherwise, or beyond 512 KiB, a spool file named as the request's input). `urls` may have
  any indices (an `OffsetArray`): `outputs` and `bodies` have the same, and so do the
  results, `similar(urls, ...)`.

Measured (test/e2e, 14 requests to a local server with 50 ms latency; sequential is 700 ms):
`@sync`/`@async` 75–98 ms in Node (all 14 in flight at once) and 163 ms in headless Chromium
(at most 6 in flight: the browser's connections per host for HTTP/1.1; 66 ms for 6 requests);
`request_all` in a program of one task 69–106 ms in Node, 165 ms in Chromium. Without the
`julia_io` events the same `@sync`/`@async` module takes 744–763 ms.

## Decompress

```julia
WasmHost.Decompress.decompress(src, dst; format = :auto)   # -> abspath(dst)
```

- **Formats:** `:auto` recognizes gzip and zstd by their magic bytes, as Pkg's
  `detect_archive_format` does; `:gzip`, `:deflate` (the zlib format, RFC 1950) and `:zstd`
  name one.
- **Hosts:** gzip and deflate on every host with an adapter; zstd where the host has it.
- **Errors:** a `DecompressError(errno, message)` with a WASI errno:
  - `EILSEQ` (25): the data isn't of the format, or of no format `:auto` knows;
  - `EIO` (29): corrupt data or an I/O error;
  - `ENOENT` (44): no source file;
  - `ENOSYS` (52): no host adapter (natively, too), or no decompressor for the format (bzip2,
    xz and lz4 by magic bytes; zstd on a host without it).

  `dst` doesn't exist after a failure.
- **Transport:** always the spool directory, also in a build whose downloads use the import
  transport.

### Pkg

Pkg decompresses by running processes: `get_extract_cmd` pipes `7z` or `zstd` into Tar, under
`unpack`, `download_verify_unpack`, `verify_archive_tree_hash` and the registry's
`uncompress_registry`. A Wasm module can't run them, so a Wasm build of Pkg routes those call
sites through a seam of its own, which stays in that build:

- `with_decompressed(f, tarball)` decompresses `tarball` into a fresh temporary file with the
  seam's `decompress(src, dst)`, calls `f` with the tar's path, and removes the file;
- the seam's Wasm `decompress(src, dst)` calls `WasmHost.Decompress.decompress(src, dst)` and
  maps a `DecompressError` to the build's own error type;
- natively the seam keeps Pkg's processes.

WasmHost overlays nothing of Pkg.

## Platform

```julia
WasmHost.Platform.tags()            # ["arch" => "x86_64", "os" => "linux", "libc" => "glibc", ...] or nothing
WasmHost.Platform.host_platform()   # a Base.BinaryPlatforms.Platform, as HostPlatform() natively, or nothing
```

- **The tags:** `WASMHOST_PLATFORM="k=v;k=v;..."` in the WASI environment, set by the host
  adapter. Node's (`js/node/platform.mjs`, `platformEnv(overrides)`) detects arch, os and libc;
  `overrides` add or replace tags (e.g. `libgfortran_version`, `cxxstring_abi`), checked as
  BinaryPlatforms checks them.
- **`host_platform()`** builds the `Platform` with this program's `julia_version`, and makes it
  a host platform as `HostPlatform()` makes the native one. With the native `HostPlatform()`'s
  tags it equals `HostPlatform()` (tested).
- **An older variable name:** a program that used another name passes it,
  `host_platform(names = ("WASMHOST_PLATFORM", "OLD_NAME"))`; the first one set wins.
- **Regex:** `host_platform()` needs a regex engine in the module. The `Platform` constructor
  can parse version tags with a `Regex`, so the closed world contains it. WasmCodegen's
  `:julia_regex` host extension no longer exists; use
  [WasmCompat.jl](https://github.com/JuliaWASM/WasmCompat.jl)'s PCRE2 backend, opt-in through
  `WasmCompat.pcre2_config(WasmCodegen.Config(host = :wasi))` (the host also instantiates
  `libpcre2-8.wasm`: WasmCompat's `js/pcre2.mjs`). `tags()` doesn't need it.

## Page

Messages between the program and the JavaScript around it. What the bytes mean is up to the
program and the page: a plot's MsgPack update, JSON, text.

```julia
WasmHost.Page.send(bytes)         # a Vector{UInt8} or a String: the page's onMessage gets the bytes
WasmHost.Page.receive()           # the page's next posted message (a Vector{UInt8}), or nothing
WasmHost.Page.poll(f)             # f(bytes) for each posted message; how many there were
```

```js
import { makePage } from './WasmHost.jl/js/common/page.mjs';   // (or js/node/, js/browser/page.mjs)
const page = makePage({ onMessage: (bytes) => deliver(bytes.slice()) });
const inst = await WebAssembly.instantiate(mod, { ...wasiImports, ...page.imports });
page.bindMemory(inst.exports.memory);
page.post(new TextEncoder().encode('{"zoom": 3}'));   // read by the program's next receive/poll
```

- **Building:** pass `import_libraries = ["wasm_host_page"]` to `Config`. The package extension
  `WasmHostPageExt` (loaded with WasmCodegen) compiles `Page`'s methods. The import library's
  protocol is documented in `src/page.jl`, and its host side is `js/common/page.mjs`, which
  needs no Node or browser API.
- **The bytes are the page's only during `onMessage`.** A message is a view of the module's
  memory: the module's next send writes over it, even one made from `onMessage` by calling back
  into the module, and growing the memory detaches it. Copy it (`bytes.slice()`) to keep it.
- **An exception of `onMessage` stays on the page's side:** `onError(error, bytes)` gets it (by
  default it is logged), `stats.errors` counts it, and `send` returns as usual. Thrown into the
  module, it would unwind the module's frames without running their `finally` blocks, because
  WasmCodegen catches only Julia's exceptions. Staging's scope would then stay allocated.
- **Through the memory:** `send` is one call of any size, for `host = :wasi` and `host = :js`
  (with WasmCodegen's `js/julia.mjs`: `instantiate(bytes, { imports: page.imports })`).
  WasmCodegen copies a `Vector{UInt8}` or `String` argument of a declared import to the linear
  memory and passes its offset and length. `receive` and `poll` copy the host's message in
  through WasmCodegen's staging area (`Runtime.Staging`), in chunks of at most 1 MiB, so they
  are for `host = :wasi` only: WasmCodegen's bytes arguments go from the module to the host, and
  a module for JavaScript that calls them doesn't compile.
- **Hosts:** Node 24 or newer, or Bun 1.4 or newer (tested with Node 24 and 26 and Bun 1.4).
  No JSPI and no flags are needed, because the page functions don't suspend. `page.mjs` uses no
  Node API, so a browser should work too, but none has been tested.
- **Natively** there is no page: `send` keeps a copy in `Page.native_outbox()`, and `receive`
  takes from `Page.native_inbox()`, which a test fills.
- **Not for suspended calls:** with `Config(tasks = :jspi)`, a task that sends while another
  is suspended inside a `wasm_host_page` call isn't supported. The functions don't suspend, and
  Staging's scopes assume one synchronous call stack.

### Pushing instead of pulling

A module without a way to pass bytes leaves the page to pull a message out through an export,
4 bytes per call: the tyler-map demo (JuliaWASM/demos) reads WGLMakie's MsgPack updates with
`msg_word(i, j)`. `Page.send` pushes the message in one call instead. Per 1 KiB message, with
`wasm-opt -O3`, Node 24 on aarch64 (`test/e2e/prun.mjs`):

| | µs per 1 KiB message |
|---|---|
| pulled, 256 calls of a 4-byte export | ~22 |
| `Page.send` (`:wasi` / `:js`) | 1.4 / 1.3 (Node 26: 1.3 / 1.2; Bun 1.4: 1.2 / 1.0) |

To migrate:
- the program calls `WasmHost.Page.send(take!(io))` where it queued a message for `msg_word`;
- the page delivers in `onMessage` (`Bonito.process_message(Bonito.decode_binary(bytes, …))`)
  instead of looping over `msg_word`;
- the export calls that pulled go away, as does the queue they read (`clear_msgs!`).

## Requirements

- Julia 1.12 or 1.13.
- A WasmCodegen with WASI support for `Config(host = :wasi)`: the filesystem and the
  environment (`ENV`). Upstream `main` has both.
- Node 24 or newer for the Node adapter, or Bun. The `jspi` mode needs JavaScript Promise
  Integration (`WebAssembly.Suspending` and `WebAssembly.promising`), which Node 24 and later
  have without a flag. (Node 22 has only the older JSPI API, behind a flag the adapter
  doesn't use, and Node 26 rejects the flag: don't pass it.)
- For the browser adapter: a browser with JSPI (Chrome or Edge 137+) and
  [`@bjorn3/browser_wasi_shim`](https://github.com/bjorn3/browser_wasi_shim) (tested: 0.4.2).

## Building

WasmCodegen isn't registered: add it, with its WasmBuilder and IRStructurizer, from source.

```julia
# build.jl, run with an environment that has WasmCodegen, Downloads and WasmHost
using WasmCodegen, Downloads, WasmHost      # loading all three loads the extension
include("myprogram.jl")                     # defines main()::Int32, which uses Downloads

c = WasmCodegen.compile([WasmCodegen.Entry(main, (); name = "main")];
                        config = WasmCodegen.Config(host = :wasi, verify = :error))
write("main.wasm", c.bytes)
```

**`verify = :error` passes** for programs that use the Downloads extension: WasmCodegen's trim
verifier checks overlaid methods with the module's own inference
([gbaraldi/WasmCodegen.jl#60](https://github.com/gbaraldi/WasmCodegen.jl/pull/60)). The
end-to-end test builds its `fetch` program with `verify = :error`, in both transports; its
`decompress` program, which isn't built in CI (it needs the removed `julia_regex` host
extension), still uses `:warn`.

**The import transport:** also define `WasmHost.transport() = :import` before compiling, and
pass `import_libraries = ["wasm_host"]` to `Config`. `transport` is a function rather than a
setting read at run time, so that the module contains only the transport it uses.

## Running in Node (spool transport)

```js
import { WASI } from 'node:wasi';
import fs from 'node:fs';
import { wrapWasi, platformEnv } from './WasmHost.jl/js/node/index.mjs';

const work = '/abs/work';                        // preopened at the same path
const spool = `${work}/.wasmhost`;               // the module finds it in ENV
const wasi = new WASI({ version: 'preview1', preopens: { [work]: work },
                        env: { WASMHOST_SPOOL: spool, PWD: work, ...platformEnv() } });
const host = wrapWasi(wasi.wasiImport, { preopens: { [work]: work }, spool, mode: 'jspi' });

const inst = await WebAssembly.instantiate(new WebAssembly.Module(fs.readFileSync('main.wasm')),
                                           { wasi_snapshot_preview1: host.wasiImport });
host.bindMemory(inst.exports.memory);
wasi.initialize(inst);
await WebAssembly.promising(inst.exports.main)();   // mode 'sync': call inst.exports.main() directly
```

Without the adapter, or without `WASMHOST_SPOOL`, every request fails with a
`Downloads.RequestError` (code 2), as a program without libcurl would, and every decompression
with `DecompressError(52)`.

## Hosts

The JavaScript side has one adapter per host family under `js/`, each laid out as a future npm
package with a `package.json` that isn't published yet. They share the host-independent
protocols in `js/common/`. See [`js/README.md`](js/README.md).

| Host | Future package | Downloads | Decompression | Platform tags | Waiting | Tested? |
|---|---|---|---|---|---|---|
| **Node** 24+ (`node:wasi`) | `@wasmhost/node` (`js/node/`) | spool (`spool.mjs`), import (`imports.mjs`) | spool: gzip, deflate, zstd | detected arch, os, libc + overrides | JSPI; sync worker (spool) | **Yes** (CI, with Bun 1.4): spool in both modes; import |
| **Browsers** with JSPI (Chrome/Edge 137+) | `@wasmhost/browser` (`js/browser/`), on `@bjorn3/browser_wasi_shim` | spool (`spool.mjs`), import (`imports.mjs`); bodies in the shim's in-memory filesystem | spool: `DecompressionStream`: gzip, deflate; zstd where the browser has it | none to detect | JSPI only; one call at a time per module (`promisingExports`); a re-entrant call poisons the instance (make a new one) | **Yes:** spool and import in headless Chromium 158 (Playwright), against native; decompression: the adapter alone. The browser's User-Agent replaces the program's, and CORS applies: see [`js/browser/README.md`](js/browser/README.md) |
| **workerd** | – | import fits; no filesystem | `DecompressionStream` | – | JSPI, if available | **No** (`js/workerd/`) |
| **wasmtime** | – | CLI: no (needs a helper process and polling); import from an embedding | the embedding's | the embedding's | the embedding's | **No** (`js/wasmtime/`) |

## Internal APIs it relies on

- **`WasmCodegen.Runtime.WASM_METHODS`:** WasmCodegen's internal mechanism today, and how its
  own runtime replaces methods. (`@wasm_method` is `Base.Experimental.@overlay` on it.) It isn't
  yet a supported interface for packages; that is being asked upstream.
- **`WasmCodegen.Runtime.Staging`:** used by the import transport and by `Page.receive`.
- **`WasmCodegen.Runtime.Host.await_handle`, `Runtime.Host.close`, `Runtime.Tasks.enabled`:**
  the concurrent requests (a task's wait for a host handle). Without `Runtime.Tasks.enabled`
  (an older WasmCodegen), requests wait as in a program of one task.

Expect to update this package when either changes.

## Tests

- `test/runtests.jl`: native tests of the modules and their protocols (`Page`'s native queues), and of the Node
  adapter's parts when `node` is on `PATH` (the protocol round trip, decompression with
  `node:zlib`, platform tags against the native `HostPlatform()`, the page adapter on a memory
  of its own). Run them with `Pkg.test()`.
- `test/e2e/e2e.jl`: compiles programs with WasmCodegen and runs them in Node.
  - `spool`, `import`: `test/e2e/prog.jl` (plain Downloads calls: an `IOBuffer` body, a 3 MiB
    file, a redirect with a custom header, HEAD, POST, a 404, a refused connection,
    `throw = false`, an explicit `Downloader`, progress) against a local server. Its output and
    downloaded bytes must equal the native program's.
  - `decompress`: `test/e2e/dprog.jl` on a real artifact tarball, gzip and zstd as the Pkg
    server serves it, and deflate. The bytes must equal what native Pkg's own decompressors
    (`get_extract_cmd`: 7z, zstd) give, whose tree hash is the artifact's. Error cases, and
    the platform lines against the native run.

  - `page`: `test/e2e/pprog.jl` sends patterns of 0, 1, 7, 1 KiB, 64 KiB and 1 MiB + 1 bytes
    and UTF-8 strings (up to 1.2 MB), and sends back what the host posts (`prun.mjs`). Its
    output and the messages the host receives must equal the native run's (`pnative.jl`). It
    runs for WASI, then for JavaScript (sending only).
  - `WASM_RUNTIME=chromium`: the browser adapter in Playwright's headless Chromium
    (`test/e2e/browser/`; `npm ci` and `npx playwright install chromium` there first). spool and
    import as above, the test resources on another origin than the page (CORS); the User-Agent
    the server echoes must be the browser's. `decompress`: the adapter's decompression alone. `page` isn't run
    there.

  - `concurrent`: `test/e2e/cprog.jl` (`@sync`/`@async`, `asyncmap`, a task fetched later, a
    failure in `@sync`), built with `tasks = :jspi` and `verify = :error`, against the local
    server's tiles with a fixed latency. The output and files must equal native's and the wall
    times must show the requests overlapping; then the same module without the `julia_io`
    events for the adapter (each request suspending the module), for comparison.
  - `batch`: `test/e2e/bprog.jl`, `WasmHost.Downloads.request_all` in a program of one task
    (`verify = :error`), the same checks.

  ```
  julia test/e2e/e2e.jl /path/to/WasmCodegen.jl [spool|import|decompress|page|concurrent|batch|all] [spool|import]
  ```

## License

MIT
