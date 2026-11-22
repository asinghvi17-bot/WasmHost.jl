# WasmHost.Bridge: values between a module and its page, on WasmHost.Page

`WasmHost.Bridge` (`src/bridge.jl`) and its host side (`js/common/bridge.mjs`) carry values
between a compiled module and its page, in both directions, after the module has started:
browser events (mouse, keys, scroll) into a Makie scene's `events(scene)`, a session's `evaljs`
out to the page, a pick that asks the page and waits for its answer.

It is a layer on [`WasmHost.Page`](../src/page.jl): every frame of the module is one
`Page.send`, every record of the page one `Page.receive`, and a receiving task waits with
`Page.wait_message`. A page's event is never a call into the module. The module's receiving task
waits on a `julia_io` external handle, and the page's `post` completes that handle.

## Use

Module (Julia, compiled by WasmCodegen with `tasks = :jspi`, `host_extensions = [:julia_io]` and
`import_libraries = ["wasm_host_page"]`):

```julia
const B = WasmHost.Bridge
B.send(Dict{String,Any}("msg_type" => "2", "payload" => payload))   # module -> page; never suspends
t = @async B.serve(msg -> handle(msg))                  # page -> module: parked in recv while there are none
answer = B.ask(Dict{String,Any}("op" => "pick", "x" => 3))  # send, park until the page answers
B.close("done")                                          # the end (serve ending closes it too)
```

Page (JavaScript, any engine with JSPI):

```js
const bridge = makeBridge({
  events,                                   // the module's julia_io events (WasmCodegen's js/julia_io.mjs)
  guard,                                    // optional: a browser adapter's re-entry check of every import
  onMessage: (value) => { /* the module's send */ },
  onAsk: async (request) => answer,         // the module's ask: the value, or a rejection (AskError in the module)
  onClose: (reason, by) => { /* by: 'module' or 'page' */ },
  onError: (err, value) => { /* onMessage threw */ },
  capacity: 1024, maxBytes: 16 << 20, overflow: 'reject',
});
const inst = await WebAssembly.instantiate(mod, { ...wasiImports, ...bridge.imports, julia_io: { ...events.imports, ... } });
bridge.bindMemory(inst.exports.memory);
bridge.post({ msg_type: '0', id: obsId, payload });   // from any DOM event handler
bridge.close('page closed');                          // the page goes away
```

`makeBridge`, `encodeFrame`, `decodeFrame`, `BridgeClosedError` and `BridgeFullError` are exported
by `js/node/index.mjs`, `js/node/bridge.mjs` and `js/browser/bridge.mjs`. No adapter is involved:
`bridge.imports` are the module's `wasm_host_page` imports, made by `makePage`.

The module needs a task of its own in `serve` for the page's messages and for the answers to its
asks. A task that asks must not be the serving task: a listener that asks runs the ask with
`@async`, as WGLMakie's `on(comm)` handler does. A program with no task of its own that waits (a
module whose exports return) can call `B.drain(f)` (`recv(wait = false)`) at the start of each
export instead. That needs no `julia_io` events.

## Protocol `wasm-bridge 2`

- **Module to page:** a frame per `Page.send`. Control members of its object: `"bridge_ask": id`
  (a request of `ask`) and `"bridge_close": reason` (the module closed the bridge; not passed to
  `onMessage`).
- **Page to module:** records `u8 kind | frame`, one per `Page.receive`. Kind `0` is a message the
  page posted, kind `1` an answer to an ask (`{"bridge_reply": id, "value": v}` or `"error"`),
  which only `bridge.reply` (or `onAsk`) makes, kind `2` the page's close (the frame of its reason).
  The module resolves asks from kind-`1` records only: a posted message is data however it
  serializes (`toJSON` included), even if it has a `bridge_reply` member. Every receive delivers
  the answers, not only `serve`'s, and `recv(wait = true)` waits on if a receive brought answers
  alone.
- **The bridge's queue is Page's `source`:** the module takes the records one at a time, when it
  looks at the next message. So the queue's limits are the bridge's, and nothing sits in Page's
  own queue.
- **A frame** is `u32le header_length | header | blobs`. The header is JSON. A numeric vector
  is in the blob region (8-byte aligned), and the JSON holds `{"$b": [offset, bytes, "f32"]}` in
  its place: a typed array on the page (tags `f32 f64 u8 i8 i16 u16 i32 u32`). A frame without
  blob bytes has no blob region, so an empty blob (`bytes` 0) may point at or past the frame's
  end: decoders take it as an empty array wherever it points. `NaN` and `±Inf` are `null`.

## The codec

`encode(x)` / `send(x)` take, by type:

- `nothing`, `missing` (`null`), `Bool`, any `Integer`, any `AbstractFloat`, any
  `AbstractString`, `Symbol`, `AbstractChar`;
- an `AbstractVector` of `Float32 Float64 Int8 UInt8 Int16 UInt16 Int32 UInt32` (a blob), any
  other `AbstractVector` and any `Tuple` (an array);
- an `AbstractDict` with string or symbol keys, and a `NamedTuple` (an object).

Decoded, the page's values are `Dict{String,Any}`, `Vector{Any}`, `String`, `Int64`, `Float64`,
`Bool`, `nothing`, and typed vectors for typed arrays.

**Trim-safety.** An element is encoded by its type when the container's element type is concrete,
so the calls are resolved when the module is compiled. An element whose declared type is not
concrete (the values of a `Dict{String,Any}`, a `Vector{Any}`, a `Union`) is encoded by its
run-time type, which must be one of a closed list (`encode_any!`). A method of `Bridge.encode!`
for a type of your own extends the codec for values of that known type. Anything else is a
`BridgeError`. The e2e program compiles all of this with `verify = :error`.

## Lifecycle and errors

- **`Bridge.close(reason)`** (or `serve` ending, normally or by an error): every pending
  `ask` fails with a `BridgeClosedError`, a parked `recv` wakes (`Page.wake`, which cancels its
  handle) and throws one, and so does every later `recv`, `send` and `ask`. The page is told
  (`onClose(reason, 'module')`), and its later `post`s throw a `BridgeClosedError`.
- **`bridge.close(reason)` on the page**: the queue is dropped, the close record is queued and a
  parked receive woken; later `post`s throw. In the module, the receive takes the close: `serve`
  returns, pending asks fail with `BridgeClosedError(reason)`, and so does everything after. The
  module's frames sent meanwhile are dropped.
- **`serve`** returns when `f` returns `false` or the bridge is closed, and rethrows an error of
  `f` or of a receive. Either way it closes the bridge first, so no ask waits for ever.
- **An ask's error:** the page's `onAsk` threw or rejected, `bridge.reply(id, promise)` rejected,
  or `onMessage` threw for the ask: `{"bridge_reply": id, "error": message}`, an `AskError`.
- **`bridge.reply(id, answer)`** returns `true` when it takes the answer, `false` (nothing queued,
  `stats.strayReplies`) for an id the module isn't waiting for: never asked, answered already,
  or a closed bridge.
- **`send`** returns `nothing`. What the page's `onMessage` throws stays on the page (Page's rule:
  nothing is thrown into the module): `onError(err, value)` gets it, `stats.errors` counts it.
  On a closed bridge `send` throws a `BridgeClosedError`; a close by the page reaches the module
  at its next receive.

## The page's queue

Records the page posts while the module is not parked wait in a queue of at most `capacity`
messages and `maxBytes` bytes. When it is full:

- `overflow: 'reject'` (the default): `post` throws a `BridgeFullError` and queues nothing.
  `bridge.room()` says how much still fits, `bridge.pending()` how much waits.
- `overflow: 'drop-oldest'`: the oldest messages are dropped to make room (`stats.dropped`).

A frame larger than `maxBytes` always throws. The answer to each of the module's asks is always
queued and never dropped, and it doesn't count towards the limits (one exempt reply per
outstanding ask). An answer larger than `maxBytes`, or one that can't be encoded, becomes the
ask's error answer. A `post` of something that isn't JSON (`undefined`, a function) throws.

## Re-entry

Give `makeBridge` a `guard` (Page's hook, called first in every `wasm_host_page` import) to
refuse a call into the module while it is suspended: in a browser, `notSuspended(wasi, events)`
of the browser adapter (`js/browser/jspi.mjs`, feat/browser-adapter and feat/concurrent-fetch),
which throws a `ReentryError` and poisons the instance. The page's `bridge.post` never calls the
module, so it is safe at any time. Re-entrant calls are deliberately not supported.

## Tests

- `Pkg.test()`: the codec (round trips with the JavaScript codec), Bridge natively on Page's
  native queues (records, asks, the page's close), and `js/common/bridge.mjs` with Page's wait,
  source and guard on their own (`test/bridge_unit.mjs`).
- `julia test/e2e/e2e.jl WASMCODEGEN bridge` (Node): `test/e2e/brprog.jl`, compiled with
  `verify = :error`, and the page's side `test/e2e/bdrive.mjs`, run by `test/e2e/brun.mjs`. Cases:
  `main` (the codec's values, events in order, the queue overflowing, two asks answered out of
  order, a failed ask, a pick: an evaljs-style ask the page runs, with a stand-in
  `WGL.pick_closest`), `page-close`, `serve-fails`, `module-close`.

## Limitations

- `ask` has no timeout: close the bridge, or answer with an error, to end a waiting ask.
- One receive at a time per module (`serve`'s task).
- A value typed `Any` at a `send` call isn't encodable in a trimmed module (see the codec).
- Waiting needs WasmCodegen's Julia tasks on `julia_io` (`feat/task-park-host-wait`).
- Not run in a browser here: the guard hook is tested in Node only.
