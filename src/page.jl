"""
    WasmHost.Page

Messages between a compiled program and the JavaScript around it (a page, a worker, a Node
script): the program [`send`](@ref)s bytes to a callback of the host, and [`receive`](@ref)s (or
[`poll`](@ref)s) the bytes the host posts to it. What the bytes are is the program's and the
page's business: a MsgPack update of a plot, JSON, text.

Import library `wasm_host_page` (`Config(import_libraries = ["wasm_host_page"])`), whose host side
is `js/common/page.mjs`. Offsets and lengths are of the module's linear memory (`memory`), as
`i32`s; byte positions are 0-based:

    send(off, len)             the bytes of a message
    pending() -> i32           the length of the host's next message, or -1 when there is none
    read(off, start, n)        copy bytes start, ..., start + n - 1 of that message to off
    pop()                      that message is done: the next one is next
    wait() -> i32              0: a message is pending; else a `julia_io` handle, ready when one is
                               (or the module's `wake`); -1: the host can't wait; -2: one waits already

The bytes of `send` are the host's only during the call (the module may write over them
afterwards): the host copies what it keeps. `js/common/page.mjs` gives the callback a view of
the memory. The host's functions
must not throw into the module: a JavaScript exception unwinds its frames without running their
`finally` blocks (`page.mjs` gives the callback's exceptions to `onError`).

How the bytes reach the memory (`WasmHostPageExt`): WasmCodegen copies the `Vector{UInt8}` or
`String` argument of `send` to the memory itself and passes its offset and length (`host = :wasi`
and `host = :js`); `receive` copies in through WasmCodegen's staging area (`Runtime.Staging`), in
chunks of at most `Staging.CHUNK` (1 MiB), so receiving is for `host = :wasi` only.

[`wait_message`](@ref) parks a Julia task until the host has a message (a program compiled with
`tasks = :jspi` and `host_extensions = [:julia_io]`; the host's `makePage` gets the `events`): the
host's `post` completes a handle of the call in flight, so nothing calls into the module.

Natively there is no host: `send` keeps a copy of the message in [`native_outbox`](@ref), and
`receive` takes the messages of [`native_inbox`](@ref), which a native test fills. A program
then runs natively as it does against a host that answered those messages.
"""
module Page

const OUTBOX = Vector{UInt8}[]
const INBOX = Vector{UInt8}[]

"The messages a program running natively has sent, oldest first (a test empties it)."
native_outbox() = OUTBOX
"The messages a program running natively will receive, oldest first (a test fills it)."
native_inbox() = INBOX

"""
    send(bytes::Union{Vector{UInt8},String}) -> nothing

Give a message to the host: its callback gets these bytes (a `String`'s UTF-8 code units).
"""
send(bytes::Vector{UInt8}) = (push!(OUTBOX, copy(bytes)); nothing)
send(s::String) = (push!(OUTBOX, Vector{UInt8}(codeunits(s))); nothing)

"""
    receive() -> Union{Vector{UInt8},Nothing}

The host's next message, or `nothing` when it has posted none. It does not wait: a program
asks again when the host calls it next.
"""
receive()::Union{Vector{UInt8},Nothing} = isempty(INBOX) ? nothing : popfirst!(INBOX)

"""
    poll(f) -> Int

Call `f(bytes)` for each message the host has posted, in order; how many there were.
"""
function poll(f::F)::Int where {F}
    n = 0
    while true
        m = receive()
        m === nothing && return n
        f(m)
        n += 1
    end
end

# the handle a task waits on in `wait_message` (0: none), for `wake`
const PARKED = Ref(Int32(0))

"""
    wait_message() -> nothing

Wait until the host has a message for [`receive`](@ref) (at once if it has one), or until
[`wake`](@ref) is called: as a Julia task, which is parked while the others run (in a program of
one task, the module suspends until the host posts). One task waits at a time. The host must
have been given WasmCodegen's `julia_io` events (`makePage({ events })`), and the program be
compiled with `host_extensions = [:julia_io]`.

Natively nothing can post while the program waits: it returns if `native_inbox()` has a
message, and throws otherwise.
"""
function wait_message()
    isempty(INBOX) && throw(ErrorException("Page.wait_message: no message, and natively nothing will post one"))
    return nothing
end

"""
    wake() -> nothing

End the [`wait_message`](@ref) of another task now (it returns, with or without a message);
nothing if no task waits. For a program that stops receiving.
"""
wake() = nothing

end # module Page
