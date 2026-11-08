# A JS↔wasm session bridge for WGLMakie: design, evidence, prototype

Branch `feat/session-bridge` of WasmHost.jl. Everything here was measured with Julia 1.13.2, WasmCodegen
`feat/task-park-host-wait` @467d91ed, WasmCompat `feat/observables-ext` @8df2164, Bonito 5.3.0, Makie
`trim/axis-typed-access` @e2f01244 merged with `trim/computepipeline-static-dispatch` @37cb4114 (merge is local).
Permalinks are to `asinghvi17-bot/Makie.jl` @e2f012445e783c5bf26a88bd5bfd2455786d0d53 (the WGLMakie files are
the same in both branches; `events.jl` before the patch in `0001-…patch`).

## 1. What WGLMakie says to the page after the first display

`B = https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src`
(the permalinks below are `B/<file>#L<line>`; written out for the ones that matter)

`js_property` and `onjs` are not used by WGLMakie at all (`grep` over `WGLMakie/src`: no hits). The traffic is
`evaljs`/`evaljs_value`, observables interpolated into `js"..."` (Bonito registers them: they are the comm), and
`on(session, obs)`.

### Julia → JS

| What | Call | Permalink |
|---|---|---|
| plot updates (the whole interactive-update path, **works today** as `LargeUpdate`s) | `wgl_update_obs[] = LargeUpdate` → Bonito's `JSUpdateObservable` → `send` | [plot-primitives.jl#L133](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/plot-primitives.jl#L133), [#L142](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/plot-primitives.jl#L142) |
| scene init: `WGL.setup_scene_init(…, $comm, $real_size, $canvas_width, $scene_serialized, $done_init)` | `evaljs(session, js"…")` | [three_plot.jl#L159](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/three_plot.jl#L159) |
| resync after reconnect | `scene_serialized[] = …` (observable) | [three_plot.jl#L99](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/three_plot.jl#L99) |
| **insert a plot** | `Bonito.evaljs_value(session, js"WGL.insert_plot(…)")` | [display.jl#L500](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/display.jl#L500) |
| insert a scene | `evaljs_value(session, js"WGL.deserialize_scene…")` | [display.jl#L476](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/display.jl#L476) |
| **delete plots** | `Bonito.evaljs(root, js"WGL.delete_plots(…)")` | [display.jl#L597](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/display.jl#L597) |
| **delete scenes** | `Bonito.evaljs(root, js"WGL.delete_scenes(…)")` | [display.jl#L624](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/display.jl#L624) |
| free the update observable | `Bonito.delete_cached!(root, root, obs.id)` | [display.jl#L576](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/display.jl#L576) |
| close the screen | `evaljs_value(session, js"WGL.dispose_screen")` | [display.jl#L324](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/display.jl#L324) |
| screenshot (`colorbuffer`) — round trip | `evaljs_value(session, to_data; timeout = 100)` | [display.jl#L448](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/display.jl#L448) |
| **picking** (3 variants) — round trips | `evaljs_value(session, js"WGL.pick_native_matrix / pick_closest / pick_sorted")` | [picking.jl#L8](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/picking.jl#L8), [#L43](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/picking.jl#L43), [#L61](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/picking.jl#L61) |
| DataInspector tooltip | `Bonito.evaljs(session, js"…")` in `jsrender(::ToolTip)` | [picking.jl#L177](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/picking.jl#L177) |
| glyph atlas batches (text) | `Bonito.evaljs(root, glyph_batch_js(batch))`, from `sync_glyphs!`, and `watch_glyphs!` (`on(updater; priority = 1)`) | [plot-primitives.jl#L348](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/plot-primitives.jl#L348), [#L417](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/plot-primitives.jl#L417), [#L423](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/plot-primitives.jl#L423) |
| per-root metadata | `Bonito.get_metadata / set_metadata!` | [plot-primitives.jl#L356](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/plot-primitives.jl#L356) |
| HTML widgets' JS (slider, menu, …) | `js"…"` callbacks, run in JS | [html-widgets.jl#L177](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/html-widgets.jl#L177) |

### JS → Julia

| What | Call | Permalink |
|---|---|---|
| **mouse, key, scroll, paste, window events** | `on(comm) do msg; @async try … end end`, `comm = Observable(Dict{String,Any}())` | [events.jl#L55-L58](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/events.jl#L55-L58) (created at [three_plot.jl#L155](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/three_plot.jl#L155)) |
| canvas size → resize | `on(session, real_size)` | [three_plot.jl#L115](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/three_plot.jl#L115) |
| reconnect | `on(session, session.on_open)` | [three_plot.jl#L125](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/three_plot.jl#L125) |
| init done / error | `on(session, done_init)`, `on(session, on_init)` | [three_plot.jl#L184](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/three_plot.jl#L184), [display.jl#L166](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/display.jl#L166) |
| session closed | `on(session, session.on_close)` | [display.jl#L186](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/display.jl#L186) |
| glyph pulls | `on(root, sync.request)` (JS notifies a hash list) | [plot-primitives.jl#L360](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/plot-primitives.jl#L360) |
| HTML widgets' values | `Observable{Any}` that JS `notify`s | [html-widgets.jl#L75-L83](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/html-widgets.jl#L75) |
| every reply of `evaljs_value` (picks, screenshots, insert/close confirmations) | Bonito's private `comm = Observable{Any}` that the JS wrapper `notify`s (`Bonito/src/session.jl` 708-780) | picking.jl above |

Everything JS→Julia is, at Bonito's level, **one message type, UpdateObservable `{msg_type: "0", id, payload}`**
(plus `JSDoneLoading`, `PingPong`, `JavascriptError`): `process_message` looks `id` up in `session.session_objects` and calls
`update_nocycle!`. Everything Julia→JS is one `Bonito.send` → `_send(session, message, large)` → `write(connection, bytes)`.
These are the two seams.

## 2. Julia → JS: a wasm-side Session whose connection hands Bonito's bytes to the bridge

Yes in shape; **not yet a strict compile of the real `Session`** (see "What was and was not proven").

- The seam is `Base.write(connection::FrontendConnection, bytes)` (Bonito's documented connection interface,
  `Bonito/src/connection/connection.jl`). `WasmConnection <: FrontendConnection` whose `write` is `Bridge.send_frame(bytes)`
  and `isopen = true` is the whole connection (`test/e2e/sprog.jl`). `evaljs`, `onjs`, observables embedded in `js""`
  (`register_observable!` → `JSUpdateObservable`), `delete_cached!`, `get/set_metadata!` are then Bonito's own Julia.
- What the verifier says about the real `Session{WasmConnection}` (WasmCodegen `verify` listing, `results/session-experiment-errors.txt`;
  1.4 GiB peak): **10 constructs in total**, all one-liners, the first round: `Session()` draws its id with `uuid4`
  (`uv_random`); `process_message` / `route_to_remote` / `remote_route_id` compare `data["msg_type"]::Any == "0"`
  (3 dynamic `==`); `send(::Session, ::Dict{Symbol})` calls `session.ignore_message[]` (a `RefValue{Function}`);
  `route_to_remote` uses `Core._compute_sparams`. With the overlays in `sprog.jl` (a counter-based `uuid4`; a typed
  `process_message` UpdateObservable branch that does not echo the update back, the job of `update_nocycle!`'s
  `f isa JSUpdateObservable && continue`; and `JSUpdateObservable` honouring that flag) **the verifier list was empty**
  and the compile went on to code generation, where it stopped with a WasmCodegen/WasmBuilder validation error:
  `WasmValidationError in function __unpack_any_13_533 … (f32_shr_u): unknown instruction`. I did not find which Bonito
  code produces it (a Float32 reinterpreted for printing in a union-unpacking helper is my guess, unchecked).
  That is a WasmCodegen bug, not a Bonito one; a plain `Float32` path in the Bridge's own codec compiles and runs.
- **Minimal overrides** (what the experiment needed, and what remains for a full session):
  1. `WasmConnection` (`write`, `isopen`, `close`, `setup_connection`) — 5 lines;
  2. `uuid4` (OS randomness) — 2 overlays;
  3. `process_message(::Session, ::Dict{String,Any})`: the UpdateObservable branch typed (`data["msg_type"]::String`; a
     one-word upstream fix, also removes `route_to_remote`'s dynamic `==`), and `update_nocycle!`'s `Base.invokelatest(f, value)`
     replaced by the observable's closed-world `notify` (WasmCompat) with the echo suppressed;
  4. `Bonito.serialize_binary(::SerializedMessage)` → a plain-Julia MsgPack writer for the closed set of wire nodes (see
     `Bonito/src/serialization/msgpack.jl`: `Dict{String,Any}`, `Vector{Any}`, typed numeric vectors = ext 0x11-0x18,
     `SerializedObservable` 101, `SerializedJSCode` 102, `CacheKey` 104, `SerializedNode` 105, `SessionCache` 106,
     `SerializedMessage` 107, framing documented there) and `deserialize_binary` → the matching reader, with
     `compression_enabled = false`. MsgPack.jl itself dispatches on `Any` values (`pack_type` on the runtime type), so it is
     not trim-safe. **Not written** (that is the measured next step); the page then runs Bonito.js **unmodified** (it
     decodes this exact format), and `WasmHost` only moves bytes. The frame codec in `Bridge` (JSON + blobs) is what I
     used instead for the prototype, to measure the transport and the Makie side without that writer;
  5. `evaljs_value(::Session{WasmConnection}, js; timeout)`: Bonito's body spawns `Threads.@spawn wait_for(…)` polling a
     lock; replace by the parked-task request of `Bridge.ask` (below).

  Everything else (`js""` → `JSCode` is a vector of strings/objects; `print_js_code`; `register_observable!`;
  `Session` bookkeeping with `ReentrantLock`/`Channel` — fine under `tasks = :jspi`) was not flagged.
- Why not a bespoke "`Bridge.evaljs`" instead: it would work for the prototype (and does: `evaljs_message` in `mprog.jl`
  builds the Bonito-shaped message by hand), but `insert_plot!` interpolates a `Dict` of arrays, observables and an
  `ES6Module` into the JS, which is exactly what Bonito's serializer already does, with its cache/owners bookkeeping.

## 3. JS → Julia

**Delivered as a `julia_io` external-handle completion; no re-entrant export call is needed.** Evidence: Node
(`test/e2e/brun.mjs`, `mrun.mjs`) and headless Chromium 158 (`test/e2e/browser/mrun.mjs`, real mouse/wheel/keyboard
events from Playwright on a canvas), strict `verify = :error`, `tasks = :jspi`:

- The module's task parks in `Bridge.recv` on a handle from `events.external()` (as the concurrent downloads do); the DOM
  event handler calls `bridge.post(msg)`, which writes the frames and calls `events.ready(h)`; that resolves the
  suspended `julia_io.poll`; the task wakes in plain Julia. The page never calls an export for an event.
- Bonito already has this shape: `Session` owns `inbox::Channel{Vector{UInt8}}` and a reader task
  (`Bonito/src/types.jl` 622-687, `for message in inbox; process_message(session, message)`), and the websocket handler's
  only job is `put!(session.inbox, bytes)` (`connection/websocket-handler.jl` 149-156). On wasm the bridge's `serve` task is
  that handler: `put!(session.inbox, frame)` (or call `process_message` directly). The `@async` loops parked on
  `take!(inbox)` and on the bridge handle are both ordinary Julia.
- WGLMakie's own `@async` in `on(comm)` ([events.jl#L58](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/events.jl#L58)) compiles and runs.
  It does not compile *unchanged*: the handler reads a `Dict{String,Any}` and does `Float64.((sign.(scroll)...,))`, `mousedown & 1`,
  `keydown[1]`, `tuple(resize...)` on `Any`, plus `@warn … exception = (err, catch_backtrace())` and the Regex/`getfield` in
  `code_to_keyboard`: 58 distinct unsupported constructs with the original (the first Makie compile; the others were ComputePipeline's, from `resize!`). The patch `0001-WGLMakie-typed-window-events.patch` types every access
  (`msg_float/msg_int/msg_pair/…`, one method each with an `isa` chain — several methods on an `Any` argument would
  dispatch dynamically) and splits the body into `handle_window_message!`; behaviour on the native side is unchanged
  (checked: press/release/position/scroll/key). `report_window_error`, `resize_from_page!` and `code_to_keyboard` are
  overlaid in the Wasm build only (`mprog.jl`).
- **Reentrancy decision: do not formalise re-entrant calls.** One call at a time per module stays (`promisingExports`,
  `ReentryError`), for these reasons: (1) events are handle completions of the call in flight, which is exactly the
  situation the existing Tyler-style page is in when it "calls in while `update_view` is suspended" — what that page
  needs is `bridge.post`, not a second call; the second call, if the page makes it, runs Julia code on a runtime that is
  not re-entrant (WasmCodegen's handlers, the scheduler's task tables); (2) a bridge post is safe at any time: if the module
  is parked it completes the handle, if it is busy or between exports it queues and the next `recv` returns it at once
  (`parked: 2` vs `11` in the logs: the number of times the pump had to be woken); (3) a module with no resident
  task (an `update_view` that returns) drains with `Bridge.recv(wait = false)` / `Bridge.drain(f)` at the start of each
  export, with no `julia_io` events. The shape for apps: `main` starts the session task and parks for the page's lifetime.
  Bonito's own docs say listeners run on the inbox task; a listener that blocks on a reply (`evaljs_value`) deadlocks it,
  which is why WGLMakie's `on(comm)` uses `@async`; same rule here.

## 4. Picking on `await_handle`

`pick_native/pick_closest/pick_sorted` call `Bonito.evaljs_value(session, js)` ([picking.jl#L8](https://github.com/asinghvi17-bot/Makie.jl/blob/e2f012445e783c5bf26a88bd5bfd2455786d0d53/WGLMakie/src/picking.jl#L8)). Bonito's
implementation: a fresh `comm = Observable{Any}`, the JS wrapper `comm.notify({result})`, and a `wait_for` poll. On the bridge
(`Bridge.ask`, `mprog.jl`'s `pick`, run in Node and Chromium):

1. the asking task sends the EvalJavascript message with a request id and parks on a `Channel` (a scheduler wait, no host handle);
2. the serving task is parked in `recv`'s external handle (`await_handle`);
3. the page evaluates the source (a promise is awaited), and `bridge.post({bridge_reply: id, value})` completes the handle;
4. the serving task puts the value in the channel; the asking task wakes and returns. The module is suspended in
   `julia_io.poll` exactly while every task waits.

So a pick costs one `send` and one handle completion, no extra export call. As `evaljs_value`: overlay it for
`Session{WasmConnection}` as "register `comm`, `evaljs`, `take!` its channel" (with a `Timer`/`@async sleep` for
`timeout`; **not implemented** in `ask`). `pick_native_matrix` returns `{"size": …, "data": [[uuid, index], …]}`: the codec
has the JSON for it (a large matrix would want a typed-array reply: the codec does blobs in both directions).
Measured: the stand-in `WGL.pick_closest` replies `["1234567890", 2]` and the module prints it (`picked`).
The **real** `WGL.pick_*` is not in the test (no WGLMakie.js, no WebGL in the harness).

## Prototype (what runs)

`WasmHost.Bridge` (`src/bridge.jl`, `ext/WasmHostBridgeExt.jl`), `js/common/bridge.mjs`, and the hooks in
`js/node/spool.mjs`, `js/browser/spool.mjs` (option `bridge`); spool files `.out/.snd` and `.rq/.rcv/.inb`.
- `test/e2e/brprog.jl` (transport: strings with escapes, Float32/Int32 arrays both ways, two posts in one recv).
- `test/e2e/mprog.jl`: a real `Scene` with `events(scene)`; WGLMakie's `connect_scene_events!` (patched) on a `comm`
  `Observable`; `on(events(scene).mousebutton)` (build time), `on(OnScroll(), events(scene).scroll)` (runtime, type declared
  to WasmCompat), `mouseposition`, `keyboardbutton` handlers; evaljs-style messages to the page; a pick.
  Results: `results/makie-node.txt`, `results/makie-chromium.txt`.

## What was and was not proven

- **Proven (strict `verify = :error`, `tasks = :jspi`, Node 26 and Chromium 158):** JS events → `comm` → WGLMakie's
  handler → `events(scene)` Observables → a handler in wasm → a message to JS; request/reply (pick) with a parked task.
- **Not proven:** a strict compile of the real Bonito `Session` (blocked by a WasmCodegen codegen error after the verifier
  list was cleared); Bonito's msgpack on wasm; the real WGLMakie.js and Bonito.js on the page (needs the MsgPack writer
  above); `resize` from the page (it runs `resize!(scene, …)`, i.e. Makie's compute graph — the other task); `insert_plot!`
  itself (blocked by plot construction typing).
- Bun, workerd, wasmtime: not tested. The `sync` mode of the Node adapter has no `julia_io`; only `recv(wait = false)` works there.

## Patches needed elsewhere

- Makie/WGLMakie: `0001-WGLMakie-typed-window-events.patch` (this directory; applies to the merged tree at `WGLMakie/src/events.jl`).
- Bonito: `data["msg_type"]::String` in `process_message` and `remote_route_id`; `ignore_message` as a concrete callable
  (or a `Bool` flag) instead of `RefValue{Function}`; a `uuid4` without OS randomness for wasm builds (or `id=` honoured
  before the default is compiled). Not written as a patch (the experiment uses overlays in `sprog.jl`).
- WasmCompat (`feat/observables-ext`): `isequal_closed(::Observable{T}, val)` for concrete `T` compiles `isequal(old, val)`
  even when `ignore_equal_values` is false; for `T = Dict{String,Any}` that is a dynamic `isequal` (worked around with a
  Wasm-only `isequal(::Dict{String,Any}, ::Dict{String,Any})` overlay in `mprog.jl`).
- WasmCodegen: the `f32_shr_u` validation error above (reproducer: `test/e2e/build_session.jl`).

## Memory (peak RSS per step, one at a time)

| step | peak RSS |
|---|---|
| resolve/instantiate env (Pkg) | 2.1 GiB |
| precompile, Makie (the spike) | 4.5 GiB (4.3 GiB after the WGLMakie-only rounds: 2.9 GiB) |
| compile `brprog` (strict) | 1.10 GiB |
| compile `mprog` (strict, Makie + tasks) | 1.80 GiB (1.84 GB by `/usr/bin/time`) |
| compile `sprog` (Bonito Session experiment, verifier list only) | 1.35 GiB |
| runs in Node / Chromium | far under 1 GiB (not measured separately) |

(The environment had to be rebuilt once mid-way, after the task's scratch directory was cleared; those precompile
numbers are from the second build.)
