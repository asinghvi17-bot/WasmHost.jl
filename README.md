# WasmHost.jl

Host capabilities for Julia programs compiled to WebAssembly by
[WasmCodegen.jl](https://github.com/gbaraldi/WasmCodegen.jl): what a WASI host doesn't provide,
performed by the JavaScript host around the module. Natively nothing changes.

| Module | What | How the program uses it |
|---|---|---|
| `WasmHost.Downloads` | HTTP requests with the host's `fetch` (TLS, redirects and proxies are the host's) | plain `Downloads.download` / `Downloads.request`, through the package extension |
| `WasmHost.Decompress` | gzip, deflate and zstd decompression of a file by the host | `WasmHost.Decompress.decompress(src, dst)` |
| `WasmHost.Platform` | the host's platform tags (arch, os, libc, ...) from the WASI environment | `WasmHost.Platform.host_platform()` |

```julia
using Downloads
f() = String(take!(Downloads.download("https://example.org/data.csv", IOBuffer())))
```

**Status:** an early release. Tested end to end against native on **Node** (and Bun) and in
**Chromium** (headless, Playwright), with both transports. Other hosts are designed but
untested; see [Hosts](#hosts).

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
- **The import transport (requires an upstream change under discussion).** A
  `wasm_host.http_request` import, for downloads only. It needs WasmCodegen to let a program
  declare an import library of its own, `Config(import_libraries = ["wasm_host"])`, which is
  proposed upstream in
  [gbaraldi/WasmCodegen.jl#57](https://github.com/gbaraldi/WasmCodegen.jl/pull/57) and not
  merged. It also uses WasmCodegen's staging area of the linear memory (`Runtime.Staging`) to
  pass the request and response text. It has been tested only against a local WasmCodegen
  build that has both.
- **Waiting.** The host's work is asynchronous, and the adapter waits in one of two ways:
  - **`jspi`:** the intercepted `path_open`, or `wasm_host.http_request`, is a
    `WebAssembly.Suspending`, so the module is suspended while the host works. Call the export
    through `WebAssembly.promising`.
  - **`sync`:** the work runs on a worker thread while the main thread blocks in
    `Atomics.wait`. Node only, spool transport only. Browsers wait with JSPI only.

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
- **Waiting with Julia Tasks:** a request blocks the whole module: other Julia tasks don't run
  while it waits. Concurrent requests would need the host's event loop to wait on request
  handles.

## Decompress

```julia
WasmHost.Decompress.decompress(src, dst; format = :auto)   # -> abspath(dst)
```

- **Formats:** `:auto` recognizes gzip and zstd by their magic bytes, as Pkg's
  `detect_archive_format` does; `:gzip`, `:deflate` (the zlib format, RFC 1950) and `:zstd`
  name one.
- **Hosts:** gzip and deflate on every host with an adapter; zstd where the host has it (Node
  22.15 or newer).
- **Errors:** a `DecompressError(errno, message)` with a WASI errno:
  - `EILSEQ` (25): the data isn't of the format, or of no format `:auto` knows;
  - `EIO` (29): corrupt data or an I/O error;
  - `ENOENT` (44): no source file;
  - `ENOSYS` (52): no host adapter (natively, too), or no decompressor for the format (bzip2,
    xz and lz4 by magic bytes; zstd on an older Node).

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
- **Regex:** `host_platform()` needs WasmCodegen's host regex engine,
  `Config(host_extensions = [:julia_regex])` (and the host's `julia_regex.mjs`). The
  `Platform` constructor can parse version tags with a `Regex`, so the closed world contains
  it. `tags()` doesn't need it.

## Requirements

- Julia 1.12 or 1.13.
- A WasmCodegen with WASI support for `Config(host = :wasi)`: the filesystem and the environment
  (`ENV`). At the time of writing these are open pull requests on gbaraldi/WasmCodegen.jl, and
  upstream `main` doesn't have them yet.
- Node 22 or newer for the Node adapter (22.15 or newer for zstd), with JavaScript Promise
  Integration for the `jspi` mode (`--experimental-wasm-jspi` where it isn't on by default).
- For the browser adapter: a browser with JSPI (Chrome or Edge 137+) and
  [`@bjorn3/browser_wasi_shim`](https://github.com/bjorn3/browser_wasi_shim) (tested: 0.4.2).

## Building

WasmCodegen isn't registered: add it, with its WasmBuilder and IRStructurizer, from source.

```julia
# build.jl, run with an environment that has WasmCodegen, Downloads and WasmHost
using WasmCodegen, Downloads, WasmHost      # loading all three loads the extension
include("myprogram.jl")                     # defines main()::Int32, which uses Downloads

c = WasmCodegen.compile([WasmCodegen.Entry(main, (); name = "main")];
                        config = WasmCodegen.Config(host = :wasi, verify = :warn))
write("main.wasm", c.bytes)
```

**`verify = :error` doesn't pass yet** for programs that use the Downloads extension.
WasmCodegen's trim verifier checks the code native inference produces. Native inference
inlines Downloads' own `request(url)` before WasmCodegen's overlay table is consulted, so the
verifier reports errors in native code (libcurl's `easy_hook`) that the module never compiles.
The module itself is clean: 0 unsupported constructs with `trim = :safe`. Use `verify = :warn`
(the default) until WasmCodegen's verifier checks overlaid methods.

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
| **Node** 22+ (`node:wasi`) | `@wasmhost/node` (`js/node/`) | spool (`spool.mjs`), import (`imports.mjs`) | spool: gzip, deflate; zstd on 22.15+ | detected arch, os, libc + overrides | JSPI; sync worker (spool) | **Yes:** spool in both modes; import only with a local WasmCodegen that has the upstream change |
| **Browsers** with JSPI (Chrome/Edge 137+) | `@wasmhost/browser` (`js/browser/`), on `@bjorn3/browser_wasi_shim` | spool (`spool.mjs`), import (`imports.mjs`); bodies in the shim's in-memory filesystem | spool: `DecompressionStream`: gzip, deflate; zstd where the browser has it | none to detect | JSPI only; one call at a time per module (`promisingExports`) | **Yes:** spool and import in headless Chromium 158 (Playwright), against native; decompression: the adapter alone. The browser's User-Agent replaces the program's, and CORS applies: see [`js/browser/README.md`](js/browser/README.md) |
| **workerd** | – | import fits; no filesystem | `DecompressionStream` | – | JSPI, if available | **No** (`js/workerd/`) |
| **wasmtime** | – | CLI: no (needs a helper process and polling); import from an embedding | the embedding's | the embedding's | the embedding's | **No** (`js/wasmtime/`) |

## Internal APIs it relies on

- **`WasmCodegen.Runtime.WASM_METHODS`:** WasmCodegen's internal mechanism today, and how its
  own runtime replaces methods. (`@wasm_method` is `Base.Experimental.@overlay` on it.) It isn't
  yet a supported interface for packages; that is being asked upstream.
- **`WasmCodegen.Runtime.Staging`:** used by the import transport only.

Expect to update this package when either changes.

## Tests

- `test/runtests.jl`: native tests of the three modules and their protocols, and of the Node
  adapter's parts when `node` is on `PATH` (the protocol round trip, decompression with
  `node:zlib`, platform tags against the native `HostPlatform()`). Run them with `Pkg.test()`.
- `test/e2e/e2e.jl`: compiles programs with WasmCodegen and runs them in Node.
  - `spool`, `import`: `test/e2e/prog.jl` (plain Downloads calls: an `IOBuffer` body, a 3 MiB
    file, a redirect with a custom header, HEAD, POST, a 404, a refused connection,
    `throw = false`, an explicit `Downloader`, progress) against a local server. Its output and
    downloaded bytes must equal the native program's.
  - `decompress`: `test/e2e/dprog.jl` on a real artifact tarball, gzip and zstd as the Pkg
    server serves it, and deflate. The bytes must equal what native Pkg's own decompressors
    (`get_extract_cmd`: 7z, zstd) give, whose tree hash is the artifact's. Error cases, and
    the platform lines against the native run.

  - `WASM_RUNTIME=chromium`: the browser adapter in Playwright's headless Chromium
    (`test/e2e/browser/`; `npm ci` and `npx playwright install chromium` there first). spool and
    import as above, the test resources on another origin than the page (CORS); the User-Agent
    the server echoes must be the browser's. `decompress`: the adapter's decompression alone.

  ```
  julia test/e2e/e2e.jl /path/to/WasmCodegen.jl [spool|import|decompress|all]
  ```

## License

MIT
