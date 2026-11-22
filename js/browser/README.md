# `@wasmhost/browser`: browser adapter

Runs a WasmHost module's downloads in a browser with the **import transport**, on
[`@bjorn3/browser_wasi_shim`](https://github.com/bjorn3/browser_wasi_shim) (tested: 0.4.2).
Needs JSPI: Chrome or Edge 137+. Tested end to end in headless Chromium (`test/e2e/browser/`).
`package.json` names the future package; it isn't published. It imports no `node:` module.

```js
import { WASI, File, OpenFile, Directory, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
import { makeImports, promisingExports } from './WasmHost.jl/js/browser/index.mjs';

// the module's filesystem, in memory; the spool directory must exist
const root = new PreopenDirectory('/work', new Map([['.wasmhost', new Directory(new Map())]]));
const wasi = new WASI(['main'], ['WASMHOST_SPOOL=/work/.wasmhost', 'PWD=/work'],
                      [new OpenFile(new File([])), ConsoleStdout.lineBuffered(console.log),
                       ConsoleStdout.lineBuffered(console.warn), root]);
const host = makeImports({ wasi });          // { imports, stats }; options: fetchImpl, credentials
const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport, ...host.imports });
wasi.initialize(inst);
const exports = promisingExports(inst);      // call the module through these only
await exports.main();
```

The module is built with `Config(import_libraries = ["wasm_host"])` and
`WasmHost.transport() = :import`. Page messages (`page.mjs`, `WasmHost.Page`) are the same
`common/page.mjs` as in Node.

## Calls: one at a time, and poisoning

**Why calls are serialized.** When the module downloads something, it stops in the middle of
the Julia function it was running and waits for `fetch`. With JSPI the page does not freeze
while it waits: buttons, timers and other code keep running, and they could call the module
again. Julia's runtime is not re-entrant: a second call would run on top of the half-finished
first one and corrupt it. So `promisingExports(inst)` queues calls: each one starts only
after the previous one has finished (succeeded or failed). Two calls at once are fine; they
just take turns.

**What poisoning means.** If something calls the module behind the queue's back
(`inst.exports.main` directly, or `WebAssembly.promising` on it) while a call is waiting, the
adapter notices when that call makes its own request. By then Julia code has already run
inside the waiting call, and it can't be undone. The adapter marks the instance as
**poisoned**: the re-entrant call, the waiting one, the queued ones and every later call
reject with an `InstancePoisonedError`. `isPoisoned(inst)` tells you whether it happened.
(A re-entrant call that makes no request isn't noticed: don't call around the queue.)

**How to recover.** You can't repair a poisoned instance. Make a new one: a new `WASI`, a new
`makeImports`, and `WebAssembly.instantiate` of the same compiled module. To avoid it, keep every call on
`promisingExports(inst)`.

## Differences from native

- CORS applies: the servers must allow the page's origin.
- The browser sends its own `User-Agent` and drops forbidden headers (`Accept-Encoding`,
  `Cookie`, ...). No credentials by default (`credentials: 'omit'`, fetch's option).
- Every network failure (refused, unresolved, TLS, CORS) is libcurl's code 7.

## Not here yet

- **The spool transport** (wrapping the shim's `path_open`) and **decompression**
  (`DecompressionStream`), which only the spool transport carries: a later PR.
- **Sync mode** (a Worker blocking in `Atomics.wait`, cross-origin isolation): not planned.
- **Platform tags:** a page has none to detect; set `WASMHOST_PLATFORM` in the WASI environment.
