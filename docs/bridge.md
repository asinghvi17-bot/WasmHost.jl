# WasmHost.Bridge: a message channel between a module and its page

`WasmHost.Bridge` (`src/bridge.jl`, `ext/WasmHostBridgeExt.jl`) and its host side
(`js/common/bridge.mjs`, served by the Node and browser adapters' `spool.mjs`) carry messages
between a compiled module and its page, in both directions, after the module has started:
browser events (mouse, keys, scroll) into a Makie scene's `events(scene)`, a session's `evaljs`
out to the page, a pick that asks the page and waits for its answer.

A page's event is never a call into the module. The module's receiving task waits on a
`julia_io` external handle, as a concurrent download does, and the page's `post` completes that
handle. Nothing re-enters the module, and `promisingExports` keeps one call at a time per
instance.

## Use

Module (Julia, compiled by WasmCodegen with `tasks = :jspi` and `host_extensions = [:julia_io]`):

```julia
const B = WasmHost.Bridge
B.send(Dict{String,Any}("msg_type" => "2", "payload" => payload))   # module -> page; never suspends
t = @async B.serve(msg -> handle(msg))                  # page -> module: parked in recv while there are none
answer = B.ask(Dict{String,Any}("op" => "pick", "x" => 3))  # send, park until the page answers
B.close("done")                                          # the end (serve ending closes it too)
```

Page (JavaScript, Node or browser adapter):

```js
const bridge = makeBridge({
  events,                                   // the module's julia_io events (WasmCodegen's js/julia_io.mjs)
  onMessage: (value) => { /* the module's send */ },
  onAsk: async (request) => answer,         // the module's ask: the value, or a rejection (AskError in the module)
  onClose: (reason, by) => { /* by: 'module' or 'page' */ },
  capacity: 1024, maxBytes: 16 << 20, chunkBytes: 1 << 20, overflow: 'reject',
});
const host = wrapWasi(wasi, { spool: '/work/.wasmhost', events, bridge });   // or Node's wrapWasi(wasiImport, ...)
bridge.post({ msg_type: '0', id: obsId, payload });   // from any DOM event handler
bridge.close('page closed');                          // the page goes away
```

`makeBridge`, `encodeFrame`, `decodeFrame`, `BridgeClosedError` and `BridgeFullError` are exported
by `js/node/index.mjs` and `js/browser/index.mjs`.

The page's bridge object has no module side: `send` (the module's messages) and `startRecv` (its
receives) belong to the port that `attachBridge(bridge)` (`js/common/bridge.mjs`) returns. The
adapter calls it once in `wrapWasi(..., { bridge })`; a second call (another adapter, or page code
that took it first) throws. So only frames the module really sent register its asks.

The module needs a task of its own in `serve` for the page's messages and for the answers to its
asks. A task that asks must not be the serving task: a listener that asks runs the ask with
`@async`, as WGLMakie's `on(comm)` handler does. A program with no task of its own that waits (a
module whose exports return) can call `B.drain(f)` (`recv(wait = false)`) at the start of each
export instead. That needs no `julia_io` events, and works in Node's `sync` mode too.

## Protocol `wasm-bridge 1`

Files of the spool directory (`WASMHOST_SPOOL`), like the other WasmHost exchanges. Opening
the response file makes the adapter do the work, and the open never suspends the module.

| module writes | then opens | the adapter |
|---|---|---|
| `<id>.out`: a frame | `<id>.snd` | its port's `send(frame)`: decodes it, calls `onMessage` (or `onAsk`), answers `ok`, `error: <message>` (`onMessage` threw) or `closed: <reason>` |
| `<id>.rq`: `wait` or `poll` | `<id>.rcv` | its port's `startRecv`: answers a handle (see below), `0` (the frames are in `<id>.inb` already), or a negated WASI errno |

- **A frame** is `u32le header_length | header | blobs`. The header is JSON. A numeric vector
  is in the blob region (8-byte aligned), and the JSON holds `{"$b": [offset, bytes, "f32"]}` in
  its place: a typed array on the page (tags `f32 f64 u8 i8 i16 u16 i32 u32`). A frame without
  blob bytes has no blob region (no padding after the header), so an empty blob (`bytes` 0) may
  point at or past the frame's end: decoders take it as an empty array wherever it points.
  `NaN` and `±Inf` are `null`.
- **The inbox**, `<id>.inb`: `u32le length | u8 kind | frame`, repeated, in the order the page
  queued them (`length` is the frame's). Kind `0` is a message the page posted. Kind `1` is an
  answer to an ask, which only `bridge.reply` (or `onAsk`) makes. The module resolves asks from
  kind-`1` records only: a posted message is data however it serializes (`toJSON` included),
  even if it has a `bridge_reply` member. Every receive delivers the answers, not only `serve`'s,
  and `recv(wait = true)` waits on if a receive brought answers alone.
- **A waiting receive** with nothing queued gets an external `julia_io` handle. The module
  waits for it (`Runtime.Host.await_handle`: with tasks, the task is parked and the others run),
  then reads `<id>.inb`. If there is no `<id>.inb` once the handle is ready, the handle's
  message (`errmsg`) says why: `wasm-bridge closed: <reason>` (the page closed the bridge) or the
  write's error (the frames stay queued).
- **Errnos of `<id>.rcv`:** `-64` (EPIPE): the bridge is closed, and the answer's second line
  is the page's reason. `-10` (EBUSY): another
  receive is pending (one at a time). `-29` (EIO): the frames could not be written, and they stay
  queued.
- **Control members** of a frame's object: `"bridge_ask": id` (a request of `ask`),
  `"bridge_reply": id` with `"value"` or `"error"` (its answer: only in a kind-`1` inbox record),
  and `"bridge_close": reason` (the module closed the bridge; not passed to `onMessage`).

## The codec

`encode(x)` / `send(x)` take, by type:

- `nothing`, `missing` (`null`), `Bool`, any `Integer`, any `AbstractFloat`, any
  `AbstractString`, `Symbol`, `AbstractChar`;
- an `AbstractVector` of `Float32 Float64 Int8 UInt8 Int16 UInt16 Int32 UInt32` (a blob), any
  other `AbstractVector` and any `Tuple` (an array);
- an `AbstractDict` with string or symbol keys, and a `NamedTuple` (an object).

So `Dict("x" => 1)`, `[true, false]`, `(1, "x")`, `(a = 1.5, b = Int64[1, 2])`, views and ranges
work as they are. Decoded, the page's values are `Dict{String,Any}`, `Vector{Any}`, `String`,
`Int64`, `Float64`, `Bool`, `nothing`, and typed vectors for typed arrays.

**Trim-safety.** The methods dispatch on abstract containers. An element is encoded by its type
when the container's element type is concrete (`Vector{Bool}`, `Dict{String,Int}`, a tuple's or
named tuple's field types), so the calls are resolved when the module is compiled. An element
whose declared type is not concrete (the values of a `Dict{String,Any}`, a `Vector{Any}`, a
`Union`) is encoded by its run-time type, which must be one of a closed list (`encode_any!`):
the scalars above, vectors of those numbers and of `Any`, `String`, `Symbol`, `Int64`, `Bool`,
`Dict{String}` / `Dict{Symbol}` of `Any`, `Dict{String}` of `String`, `Int64`, `Float64`, `Bool`,
and `NTuple`s of up to 4 `Float64`, `Float32`, `Int64` or `Int32`. A `NamedTuple` stored in a
`Dict{String,Any}` is not on the list: give such a message a concrete type (a `NamedTuple` of
the fields), or convert. Likewise, pass `send` a value whose type the compiler knows. A value
typed `Any` at the call site (an element of what `recv` returned) is sent inside a
`Dict{String,Any}`. A method of `Bridge.encode!` for a type of your own extends the codec for
values of that known type. Anything else is a `BridgeError`. The e2e program compiles all of
this with `verify = :error`.

## Lifecycle and errors

- **`Bridge.close(reason)`** (or `serve` ending, normally or by an error): every pending
  `ask` fails with a `BridgeClosedError`, a parked `recv` wakes (its handle is cancelled) and
  throws one, and so does every later `recv`, `send` and `ask`. The page is told
  (`onClose(reason, 'module')`), and its later `post`s throw a `BridgeClosedError`.
- **`bridge.close(reason)` on the page**: the queue is dropped, a parked receive completes
  with the close, later receives answer EPIPE, and `post` and the module's `send` throw. In the
  module, `serve` returns, pending asks fail with `BridgeClosedError(reason)`, and so does
  everything after.
- **`serve`** returns when `f` returns `false` or the bridge is closed, and rethrows an error of
  `f` or of a receive. Either way it closes the bridge first, so no ask waits for ever.
- **An ask's error:** the page's `onAsk` threw or rejected (or `bridge.reply(id, promise)`
  rejected), which is `{"bridge_reply": id, "error": message}`, an `AskError` in the module.
- **`bridge.reply(id, answer)`** returns `true` when it takes the answer. It returns `false`, and
  queues nothing (`stats.strayReplies`), for an id the module isn't waiting for: never asked,
  answered already (the first reply is the answer; with `onAsk` the bridge answers itself), an ask
  `onMessage` threw for, or a closed bridge. The page's side knows the outstanding ids because
  the asks arrive through `send`. In the module, an answer to an unknown or finished ask is
  dropped too.
- **`send`** returns `false` when no adapter bridge took the frame. It throws a `BridgeError`
  when the page's `onMessage` threw, and a `BridgeClosedError` when the bridge is closed.
- **A write that fails** (the adapter could not write `<id>.inb`) leaves the frames queued and
  fails that receive with a `BridgeError`, so no receive is stranded. `serve` treats it as its
  error: it fails and closes the bridge, which drops the queue. A program that would rather retry
  receives with `recv` in a loop of its own, and the next
  receive gets them.

## The page's queue

Frames the page posts while the module is not parked wait in a queue of at most `capacity`
frames and `maxBytes` bytes. When it is full:

- `overflow: 'reject'` (the default): `post` throws a `BridgeFullError` and queues nothing.
  This is the page's backpressure; `bridge.room()` says how much still fits, `bridge.pending()`
  how much waits.
- `overflow: 'drop-oldest'`: the oldest frames are dropped to make room (`stats.dropped`). Use
  it for events that only matter as the latest state (mouse moves).

A frame larger than `maxBytes` always throws. The answer to each of the module's asks is always
queued and never dropped, and it doesn't count towards the limits: the bridge exempts one reply
per outstanding ask, so the module's asks bound them. A second reply, or one to an id that wasn't
asked, is refused (`reply` returns `false`). A posted `bridge_reply` object is an ordinary
message, counted and limited like any other, which the module gets as data: an answer goes
only through `reply`, so a stale or duplicate one can't reach an ask. An answer
larger than `maxBytes`, or one that can't be encoded, becomes the ask's error answer. A `post` of
something that isn't JSON (`undefined`, a function) throws. One receive takes at most `chunkBytes` of frames (at least one frame),
so the module never reads one huge inbox. The rest is there at once for its next receive. After
a close, nothing is queued and `post` throws.

## Re-entry

The browser adapter's guard (`notSuspended`) covers the bridge's files. A send or receive while
the module is suspended (in a host job, or in `julia_io`'s `poll` with every task waiting) means
the page called into the module directly, around `promisingExports`. It is a `ReentryError`
thrown into that call, and it **poisons the instance**: the suspended call rejects with an
`InstancePoisonedError`, as does every later call and host request (`js/browser/README.md`). The
adapter knows the module is suspended in `poll` from the `events` it is given, so give `wrapWasi`
the same `events` as `makeBridge`. The page's `bridge.post` never calls the module, so it is safe
at any time. The Node adapter has no
such guard (Node has no page that calls in).

Re-entrant calls are deliberately not supported. An event is a handle completion of the call in
flight, and a second call would run Julia code on a runtime that isn't re-entrant (WasmCodegen's
handlers, the scheduler's task tables).

## Threat model

The page's JavaScript shares the module's origin, and it is trusted: it instantiates the module
and can call its exports directly. The queue limits, the reply bookkeeping (one exempt answer
per outstanding ask), and the separate record kind for answers protect against bugs and runaway
producers: a page that posts faster than the module receives, answers twice, or posts something
shaped like an answer. They are not a defence against a malicious page, which needs none of the
bridge to misuse the module. The public API is kept honest (what the page can do with the bridge
object is what this document says), and nothing beyond that is attempted.

## Tests

- `Pkg.test()`: the codec (round trips with the JavaScript codec), the native behaviour without
  a host, and `js/common/bridge.mjs` on its own (`test/bridge_unit.mjs`): a write that throws
  (the review's reproduction of a stranded receive), capacity and overflow, bounded chunks,
  closing from either side, ask answers and errors, the adapters' files.
- `julia test/e2e/e2e.jl WASMCODEGEN bridge`, with `WASM_RUNTIME=node` or `chromium` (in CI):
  `test/e2e/brprog.jl`, compiled with `verify = :error`, and the page's side `test/e2e/bdrive.mjs`.
  It asserts what the module sent, printed and returned, for each case: `main` (the codec's
  values, events in order, the queue overflowing, two asks answered out of order, a failed ask),
  `page-close`, `serve-fails`, `module-close`, `write-fails` and, in Chromium, `reentry` (direct
  calls of exports that receive and send while main is suspended: ReentryError, then
  InstancePoisonedError, and main rejects).
- `julia test/e2e/e2e.jl WASMCODEGEN makie` (opt-in, not in CI): see below.

## Makie and Bonito

`test/e2e/mprog.jl` is a real Makie `Scene` with `events(scene)`. The page's events reach it
through WGLMakie's own `connect_scene_events!` handler of `comm` (an
`Observable{Dict{String,Any}}`), and `on(events(scene).mousebutton)`, scroll, mouse position and
keyboard handlers run in the module and answer with evaljs-style messages. A pick goes through
`Bridge.ask`. `test/e2e/mrun.mjs` (Node) and `test/e2e/browser/mrun.mjs` (Chromium: real mouse,
wheel and keyboard events from Playwright on a canvas) check the log against
`test/e2e/mdrive.mjs`'s expectations.

**Its dependencies.** This part needs `E2E_MAKIE_ENV`, a Julia project with:

- Makie and WGLMakie with **`test/e2e/patches/0001-WGLMakie-typed-window-events.patch`**
  applied (to `WGLMakie/src/events.jl`). WGLMakie's handler reads the page's `Dict{String,Any}`
  with untyped accesses (`Float64.((sign.(scroll)...,))`, `keydown[1]`, ...), which don't
  compile in a trimmed module; the patch types every access and splits the body into
  `handle_window_message!`, with native behaviour unchanged. The measured tree was
  `asinghvi17-bot/Makie.jl` `trim/axis-typed-access` (e2f01244) merged with
  `trim/computepipeline-static-dispatch` (37cb4114);
- WasmCompat `feat/observables-ext` (8df2164, the observables' closed world), WasmCodegen, and
  this WasmHost.

It is not in CI, because those trees are not published together. Without `E2E_MAKIE_ENV` the
part is skipped.

**What it proves, and what it doesn't.** It proves (strict `verify = :error`, `tasks = :jspi`,
Node and Chromium) that page events reach `comm`, then WGLMakie's handler, then `events(scene)`'s
observables, then a handler in Wasm, then a message back to the page. It also proves a
request/reply on a parked task. It does not run Bonito or WGLMakie.js:

- the page's side substitutes for Bonito's dispatch: the page posts the
  `{msg_type: "0", id, payload}` UpdateObservable message Bonito would send for `comm`, and the
  module's `dispatch` sets `comm` by id (Bonito's `process_message` does that on a real session);
- the evaljs-style messages are run by `new Function`, not by Bonito.js;
- the pick is a stand-in `WGL.pick_closest` returning `["1234567890", 2]`: no WGLMakie.js, no
  WebGL, no real picking buffer;
- `resize` from the page (`resize!` of the scene, Makie's compute graph) is overlaid out.

**Bonito's `Session` in Wasm** (`test/e2e/sprog.jl`, `build_session.jl`: an experiment, not a
test). A connection whose `write` is `Bridge.send_frame` is all the transport Bonito needs (its
`FrontendConnection` interface). With a few overlays (a counter-based `uuid4`, a typed
`process_message` UpdateObservable branch, `JSUpdateObservable` honouring the echo flag), the
verifier's list for the real `Session{WasmConnection}` was empty. Code generation then stopped
with a WasmCodegen validation error (`f32_shr_u` in a union-unpacking helper: a WasmCodegen
bug). Not done yet:

- a trim-safe writer and reader of Bonito's MsgPack wire format, so the page could run Bonito.js
  unmodified;
- `evaljs_value` for `Session{WasmConnection}` on `Bridge.ask`.

## Limitations

- `ask` has no timeout (Bonito's `evaljs_value` has one): close the bridge, or answer with an
  error, to end a waiting ask.
- One receive at a time per module (`serve`'s task).
- A value typed `Any` at a `send` call isn't encodable in a trimmed module (see the codec).
- Node's `sync` mode has no `julia_io` events: only `recv(wait = false)` / `drain` work there.
- Tested with Node 26 and Chromium 158 (Playwright 1.65). Bun, workerd and wasmtime are not
  tested.
