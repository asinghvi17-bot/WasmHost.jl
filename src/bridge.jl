"""
    WasmHost.Bridge

A message channel between the module and the page, in both directions, for a program that has
to talk to its page after it has started: a Makie scene whose browser events (mouse, keys,
scroll, a picking reply) reach `events(scene)`, a session whose `evaljs` reaches the page.
Protocol `wasm-bridge 1`; see `js/common/bridge.mjs` for the host's side.

- **Module to page, [`send`](@ref):** the program writes the frame to `<spool>/<id>.out` and
  opens `<spool>/<id>.snd`; the adapter hands the frame to the page's `onMessage` and the open
  proceeds. It never suspends the module.
- **Page to module, [`recv`](@ref):** the program writes `<spool>/<id>.rq` and opens
  `<spool>/<id>.rcv`, whose content is a handle of WasmCodegen's `julia_io` events (an external
  handle, as the concurrent requests of [`Downloads`](@ref)), or `0` when the frames are there
  already. The handle is ready when the page has posted a frame (`bridge.post(value)`); the
  program waits for it as for a timer (`Runtime.Host.await_handle`: with Julia tasks the task
  is parked and the others run), then reads the frames from `<spool>/<id>.inb`. A page's event
  is never a call into the module: it completes a handle of the call in flight.
  `recv(wait = false)` takes what is there without waiting (no `julia_io` events needed): for
  a program with no task of its own that waits, called at the start of each export.

A frame is `u32le header_length | header | blobs`. The header is JSON; a numeric vector
(`Vector{Float32}`, `Vector{Int32}`, ...) is in the blob region and the JSON holds
`{"\$b": [offset, bytes, "f32"]}` in its place (a typed array on the page). [`encode`](@ref)
and [`decode`](@ref) are the codec: `nothing`, `Bool`, integers (decoded as `Int64`), floats
(decoded as `Float64`), strings, `Symbol`, vectors, tuples, dictionaries with string or symbol
keys; decoded: `Dict{String,Any}` and `Vector{Any}`. Other types are an error (extend
[`encode_other!`](@ref) for them). The branches are on concrete types, so that a trimmed module
resolves every call.
"""
module Bridge

using ..WasmHost: WasmHost, spool_dir, spool_path, spool_exchange

const PROTOCOL = "wasm-bridge 1"

"""
    BridgeError(message)

The host can't do what the program asked (no adapter bridge, a second pending `recv`).
"""
struct BridgeError <: Exception
    msg::String
end
Base.showerror(io::IO, e::BridgeError) = print(io, "BridgeError: ", e.msg)

## the codec

const BLOB_KEY = "\$b"

# the type tag of a blob and its size in bytes
blob_tag(::Type{Float32}) = "f32"
blob_tag(::Type{Float64}) = "f64"
blob_tag(::Type{UInt8}) = "u8"
blob_tag(::Type{Int8}) = "i8"
blob_tag(::Type{Int16}) = "i16"
blob_tag(::Type{UInt16}) = "u16"
blob_tag(::Type{Int32}) = "i32"
blob_tag(::Type{UInt32}) = "u32"

const BlobEltype = Union{Float32,Float64,UInt8,Int8,Int16,UInt16,Int32,UInt32}

function write_string!(io::IOBuffer, s::String)
    write(io, UInt8('"'))
    for c in s
        if c == '"'
            write(io, "\\\"")
        elseif c == '\\'
            write(io, "\\\\")
        elseif c == '\n'
            write(io, "\\n")
        elseif c == '\r'
            write(io, "\\r")
        elseif c == '\t'
            write(io, "\\t")
        elseif c < ' '
            write(io, "\\u", lpad(string(UInt32(c); base = 16), 4, '0'))
        else
            write(io, c)
        end
    end
    write(io, UInt8('"'))
    return nothing
end

# Blobs are 8-byte aligned in the blob region
function add_blob!(io::IOBuffer, blobs::IOBuffer, v::Vector{T}) where {T<:BlobEltype}
    while position(blobs) % 8 != 0
        write(blobs, 0x00)
    end
    off = position(blobs)
    for x in v
        write(blobs, htol(x))
    end
    write(io, "{\"", BLOB_KEY, "\":[", string(off), ",", string(sizeof(T) * length(v)), ",\"", blob_tag(T), "\"]}")
    return nothing
end

"""
    encode_other!(io, blobs, x)

A type the codec doesn't know: the default is an error. A module that needs one (the Bonito
extension's `JSCode`, say) adds a method for that concrete type and a branch of `encode!` for
it: the codec's branches are on concrete types so that a trimmed module resolves every call.
"""
encode_other!(io::IOBuffer, blobs::IOBuffer, @nospecialize(x)) =
    throw(BridgeError(string("can't encode a ", typeof(x))))

function encode_elements!(io::IOBuffer, blobs::IOBuffer, v)
    write(io, UInt8('['))
    first = true
    for y in v
        first || write(io, UInt8(','))
        first = false
        encode!(io, blobs, y)
    end
    write(io, UInt8(']'))
    return nothing
end

function encode_dict!(io::IOBuffer, blobs::IOBuffer, d::Dict{K,Any}) where {K}
    write(io, UInt8('{'))
    first = true
    for (k, y) in d
        first || write(io, UInt8(','))
        first = false
        write_string!(io, String(k))
        write(io, UInt8(':'))
        encode!(io, blobs, y)
    end
    write(io, UInt8('}'))
    return nothing
end

"""
    encode!(io, blobs, x)

Write `x` as JSON to `io`, and its numeric vectors to `blobs`.
"""
function encode!(io::IOBuffer, blobs::IOBuffer, @nospecialize(x))
    if x === nothing || x === missing
        write(io, "null")
    elseif x isa Bool
        write(io, x ? "true" : "false")
    elseif x isa Int64
        write(io, string(x))
    elseif x isa Union{Int32,Int16,Int8}
        write(io, string(Int64(x)))
    elseif x isa UInt64
        write(io, string(x))
    elseif x isa Union{UInt32,UInt16,UInt8}
        write(io, string(UInt64(x)))
    elseif x isa Float64
        isfinite(x) ? write(io, string(x)) : write(io, "null")
    elseif x isa Float32
        isfinite(x) ? write(io, string(x)) : write(io, "null")
    elseif x isa String
        write_string!(io, x)
    elseif x isa SubString{String}
        write_string!(io, String(x))
    elseif x isa Symbol
        write_string!(io, String(x))
    elseif x isa Char
        write_string!(io, string(x))
    elseif x isa Vector{Float32}
        add_blob!(io, blobs, x)
    elseif x isa Vector{Float64}
        add_blob!(io, blobs, x)
    elseif x isa Vector{UInt8}
        add_blob!(io, blobs, x)
    elseif x isa Vector{Int32}
        add_blob!(io, blobs, x)
    elseif x isa Vector{UInt32}
        add_blob!(io, blobs, x)
    elseif x isa Vector{Int16}
        add_blob!(io, blobs, x)
    elseif x isa Vector{UInt16}
        add_blob!(io, blobs, x)
    elseif x isa Vector{Int8}
        add_blob!(io, blobs, x)
    elseif x isa Vector{Any}
        encode_elements!(io, blobs, x)
    elseif x isa Vector{String}
        encode_elements!(io, blobs, x)
    elseif x isa Vector{Symbol}
        encode_elements!(io, blobs, x)
    elseif x isa NTuple{2,Float64}
        encode_elements!(io, blobs, x)
    elseif x isa NTuple{3,Float64}
        encode_elements!(io, blobs, x)
    elseif x isa NTuple{4,Float64}
        encode_elements!(io, blobs, x)
    elseif x isa NTuple{2,Float32}
        encode_elements!(io, blobs, x)
    elseif x isa NTuple{3,Float32}
        encode_elements!(io, blobs, x)
    elseif x isa NTuple{4,Float32}
        encode_elements!(io, blobs, x)
    elseif x isa NTuple{2,Int64}
        encode_elements!(io, blobs, x)
    elseif x isa NTuple{3,Int64}
        encode_elements!(io, blobs, x)
    elseif x isa NTuple{4,Int64}
        encode_elements!(io, blobs, x)
    elseif x isa Dict{String,Any}
        encode_dict!(io, blobs, x)
    elseif x isa Dict{Symbol,Any}
        encode_dict!(io, blobs, x)
    else
        encode_other!(io, blobs, x)
    end
    return nothing
end

"""
    encode(x) -> Vector{UInt8}

The frame of `x`.
"""
function encode(@nospecialize(x))::Vector{UInt8}
    io = IOBuffer()
    blobs = IOBuffer()
    encode!(io, blobs, x)
    header = take!(io)
    body = take!(blobs)
    out = IOBuffer()
    write(out, htol(UInt32(length(header))))
    write(out, header)
    if !isempty(body)
        while position(out) % 8 != 0
            write(out, 0x00)
        end
        write(out, body)
    end
    return take!(out)
end

# ---- decoding: JSON over bytes

mutable struct Parser
    bytes::Vector{UInt8}
    i::Int
    blobs::Int   # the offset of the blob region (0-based)
end

@noinline parse_error(p::Parser, what::String) = throw(BridgeError(string("bad frame at ", p.i, ": ", what)))

function skip_ws!(p::Parser)
    while p.i <= length(p.bytes)
        c = p.bytes[p.i]
        (c == 0x20 || c == 0x0a || c == 0x0d || c == 0x09) || break
        p.i += 1
    end
    return nothing
end

function expect!(p::Parser, c::Char)
    skip_ws!(p)
    (p.i <= length(p.bytes) && p.bytes[p.i] == UInt8(c)) || parse_error(p, string("expected ", c))
    p.i += 1
    return nothing
end

function parse_hex4!(p::Parser)::UInt32
    v = UInt32(0)
    for _ in 1:4
        p.i <= length(p.bytes) || parse_error(p, "unterminated \\u")
        c = p.bytes[p.i]
        d = c >= UInt8('0') && c <= UInt8('9') ? c - UInt8('0') :
            c >= UInt8('a') && c <= UInt8('f') ? c - UInt8('a') + 0x0a :
            c >= UInt8('A') && c <= UInt8('F') ? c - UInt8('A') + 0x0a : parse_error(p, "bad \\u escape")
        v = (v << 4) | UInt32(d)
        p.i += 1
    end
    return v
end

function parse_string!(p::Parser)::String
    expect!(p, '"')
    out = IOBuffer()
    while true
        p.i <= length(p.bytes) || parse_error(p, "unterminated string")
        c = p.bytes[p.i]
        p.i += 1
        if c == UInt8('"')
            break
        elseif c == UInt8('\\')
            p.i <= length(p.bytes) || parse_error(p, "unterminated escape")
            e = p.bytes[p.i]
            p.i += 1
            if e == UInt8('n')
                write(out, UInt8('\n'))
            elseif e == UInt8('t')
                write(out, UInt8('\t'))
            elseif e == UInt8('r')
                write(out, UInt8('\r'))
            elseif e == UInt8('b')
                write(out, UInt8('\b'))
            elseif e == UInt8('f')
                write(out, UInt8('\f'))
            elseif e == UInt8('u')
                u = parse_hex4!(p)
                if u >= 0xd800 && u < 0xdc00 && p.i + 1 <= length(p.bytes) && p.bytes[p.i] == UInt8('\\') && p.bytes[p.i+1] == UInt8('u')
                    p.i += 2
                    lo = parse_hex4!(p)
                    u = 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00)
                end
                write(out, Char(u))
            else
                write(out, e)   # " \ /
            end
        else
            write(out, c)
        end
    end
    return String(take!(out))
end

function parse_number!(p::Parser)::Union{Int64,Float64}
    start = p.i
    isfloat = false
    while p.i <= length(p.bytes)
        c = p.bytes[p.i]
        if c == UInt8('.') || c == UInt8('e') || c == UInt8('E')
            isfloat = true
        elseif !(c == UInt8('-') || c == UInt8('+') || (c >= UInt8('0') && c <= UInt8('9')))
            break
        end
        p.i += 1
    end
    s = String(p.bytes[start:p.i-1])
    if !isfloat
        v = tryparse(Int64, s)
        v === nothing || return v
    end
    f = tryparse(Float64, s)
    f === nothing && parse_error(p, "bad number")
    return f
end

function literal!(p::Parser, word::String)
    for c in word
        (p.i <= length(p.bytes) && p.bytes[p.i] == UInt8(c)) || parse_error(p, string("expected ", word))
        p.i += 1
    end
    return nothing
end

function read_blob(p::Parser, off::Int, nbytes::Int, tag::String)::Any
    start = p.blobs + off
    (start >= 0 && nbytes >= 0 && start + nbytes <= length(p.bytes)) || parse_error(p, "blob out of range")
    tag == "f32" && return blob_vector(Float32, p.bytes, start, nbytes)
    tag == "f64" && return blob_vector(Float64, p.bytes, start, nbytes)
    tag == "u8" && return blob_vector(UInt8, p.bytes, start, nbytes)
    tag == "i8" && return blob_vector(Int8, p.bytes, start, nbytes)
    tag == "i16" && return blob_vector(Int16, p.bytes, start, nbytes)
    tag == "u16" && return blob_vector(UInt16, p.bytes, start, nbytes)
    tag == "i32" && return blob_vector(Int32, p.bytes, start, nbytes)
    tag == "u32" && return blob_vector(UInt32, p.bytes, start, nbytes)
    parse_error(p, string("unknown blob type ", tag))
end

function blob_vector(::Type{T}, bytes::Vector{UInt8}, start::Int, nbytes::Int)::Vector{T} where {T}
    n = nbytes ÷ sizeof(T)
    out = Vector{T}(undef, n)
    for k in 1:n
        v = zero(UInt64)
        for b in 0:sizeof(T)-1
            v |= UInt64(bytes[start + (k - 1) * sizeof(T) + b + 1]) << (8b)
        end
        out[k] = T === Float32 ? reinterpret(Float32, v % UInt32) :
                 T === Float64 ? reinterpret(Float64, v) : (v % unsigned(T)) % T
    end
    return out
end

function parse_value!(p::Parser)::Any
    skip_ws!(p)
    p.i <= length(p.bytes) || parse_error(p, "unexpected end")
    c = p.bytes[p.i]
    if c == UInt8('{')
        p.i += 1
        d = Dict{String,Any}()
        skip_ws!(p)
        if p.bytes[p.i] == UInt8('}')
            p.i += 1
            return d
        end
        while true
            k = parse_string!(p)
            expect!(p, ':')
            d[k] = parse_value!(p)
            skip_ws!(p)
            p.i <= length(p.bytes) || parse_error(p, "unterminated object")
            if p.bytes[p.i] == UInt8(',')
                p.i += 1
            else
                expect!(p, '}')
                break
            end
        end
        # a blob reference
        if length(d) == 1
            ref = get(d, BLOB_KEY, nothing)
            if ref isa Vector{Any} && length(ref) == 3 && ref[1] isa Int64 && ref[2] isa Int64 && ref[3] isa String
                return read_blob(p, ref[1], ref[2], ref[3])
            end
        end
        return d
    elseif c == UInt8('[')
        p.i += 1
        v = Any[]
        skip_ws!(p)
        if p.bytes[p.i] == UInt8(']')
            p.i += 1
            return v
        end
        while true
            push!(v, parse_value!(p))
            skip_ws!(p)
            p.i <= length(p.bytes) || parse_error(p, "unterminated array")
            if p.bytes[p.i] == UInt8(',')
                p.i += 1
            else
                expect!(p, ']')
                break
            end
        end
        return v
    elseif c == UInt8('"')
        return parse_string!(p)
    elseif c == UInt8('t')
        literal!(p, "true")
        return true
    elseif c == UInt8('f')
        literal!(p, "false")
        return false
    elseif c == UInt8('n')
        literal!(p, "null")
        return nothing
    else
        return parse_number!(p)
    end
end

"""
    decode(frame::Vector{UInt8}) -> Any

The value of a frame.
"""
function decode(frame::Vector{UInt8})::Any
    length(frame) >= 4 || throw(BridgeError("a frame of fewer than 4 bytes"))
    hlen = Int(frame[1]) | (Int(frame[2]) << 8) | (Int(frame[3]) << 16) | (Int(frame[4]) << 24)
    4 + hlen <= length(frame) || throw(BridgeError("a frame shorter than its header"))
    blobs = 4 + hlen
    blobs += (8 - blobs % 8) % 8
    p = Parser(frame, 5, blobs)
    v = parse_value!(p)
    # (the header ends where hlen says; anything after is the blobs)
    return v
end

## the channel

"The host's handle of a started `recv` (`0`: the frames are there already) or `nothing` (no adapter bridge)."
function start_recv(base::String, wait::Bool)::Union{Nothing,Int32}
    write(base * ".rq", wait ? "wait" : "poll")
    h = nothing
    try
        h = tryparse(Int32, strip(read(base * ".rcv", String)))
    catch
        h = nothing
    end
    return h
end

"Wait, as a task, until the `julia_io` handle is ready (WasmCodegen's `Runtime.Host.await_handle`)."
function await_handle end
"Release a `julia_io` handle."
function close_handle end

"""
    available() -> Bool

Whether the program has a spool directory (the adapter may still not have a bridge: [`send`](@ref)
returns `false` then).
"""
available() = !isempty(spool_dir())

"""
    send_frame(frame) -> Bool

Hand the frame to the page. `false` if no adapter bridge took it.
"""
function send_frame(frame::Vector{UInt8})::Bool
    isempty(spool_dir()) && return false
    ans = spool_exchange(String(copy(frame)), ".out", ".snd")
    return ans !== nothing && ans == "ok"
end

"""
    send(x) -> Bool

[`encode`](@ref) `x` and hand it to the page's `onMessage`.
"""
send(@nospecialize(x)) = send_frame(encode(x))

# the frames of an `.inb` file: u32le length | frame, repeated
function split_frames(buf::Vector{UInt8})::Vector{Vector{UInt8}}
    out = Vector{UInt8}[]
    i = 1
    while i + 3 <= length(buf)
        n = Int(buf[i]) | (Int(buf[i+1]) << 8) | (Int(buf[i+2]) << 16) | (Int(buf[i+3]) << 24)
        i += 4
        i + n - 1 <= length(buf) || throw(BridgeError("a truncated frame in the inbox"))
        push!(out, buf[i:i+n-1])
        i += n
    end
    return out
end

"""
    recv_frames(; wait = true) -> Vector{Vector{UInt8}}

The frames the page has posted. With `wait`, waits (as a task, with `julia_io` events) until
there is at least one; without, returns what is there (possibly nothing).
"""
function recv_frames(; wait::Bool = true)::Vector{Vector{UInt8}}
    isempty(spool_dir()) && throw(BridgeError("no spool directory (the host gave none)"))
    base = spool_path("")
    h = start_recv(base, wait)
    h === nothing && (rm(base * ".rq"; force = true); throw(BridgeError("the host adapter has no bridge")))
    h < 0 && (rm(base * ".rq"; force = true); rm(base * ".rcv"; force = true); throw(BridgeError("the host can't receive now (errno $(-h))")))
    try
        h > 0 && await_handle(h)
        frames = split_frames(read(base * ".inb"))
        # (a host without julia_io events answers a waiting recv with what is there, `0`)
        wait && h == 0 && isempty(frames) && throw(BridgeError("the host can't wait for the page (its adapter has no julia_io events)"))
        return frames
    finally
        h > 0 && close_handle(h)
        rm(base * ".rq"; force = true)
        rm(base * ".rcv"; force = true)
        rm(base * ".inb"; force = true)
    end
end

"""
    recv(; wait = true) -> Vector{Any}

The values the page has posted, decoded.
"""
function recv(; wait::Bool = true)::Vector{Any}
    out = Any[]
    for f in recv_frames(; wait)
        push!(out, decode(f))
    end
    return out
end

## requests: a Julia task asks the page and parks until it answers (Bonito's `evaljs_value`, a pick)

const PENDING = Dict{Int64,Channel{Any}}()
const NEXT_REQUEST = Ref(Int64(0))

"""
    ask(request::Dict{String,Any}) -> Any

Send `request` with a `"bridge_ask"` id and wait, as a task (parked on a `Channel`: no handle of its own), until the
page answers with `{"bridge_reply": id, "value": ...}`, which [`serve`](@ref) (the task in `recv`) delivers. This is
what Bonito's `evaljs_value` does with its `comm` observable, and a pick (`WGLMakie.pick_native`...) is one: the asking
task parks on the channel while the serving task parks in `recv`'s host handle; the page's answer completes that handle,
the serving task puts the value in the channel, the asking task wakes. Not callable from the serving task itself (its
listener must `@async` the call, as WGLMakie's `on(comm)` does).
"""
function ask(request::Dict{String,Any})::Any
    id = (NEXT_REQUEST[] += 1)
    ch = Channel{Any}(1)
    PENDING[id] = ch
    request["bridge_ask"] = id
    try
        send(request) || throw(BridgeError("no host bridge to ask"))
        return take!(ch)
    finally
        delete!(PENDING, id)
    end
end

# an answer of the page: to the channel of its request (an unknown id, a request that gave up, is dropped)
function deliver_reply!(m::Dict{String,Any})
    id = get(m, "bridge_reply", nothing)
    id isa Int64 || return nothing
    ch = get(PENDING, id, nothing)
    ch === nothing && return nothing
    put!(ch, get(m, "value", nothing))
    return nothing
end

"""
    serve(f)

Receive until `f(message)` returns `false`: the loop of a task that serves the page's
messages (`@async Bridge.serve(...)`), parked in `recv` while there are none.
"""
function serve(f::F) where {F}
    while true
        for m in recv()
            if m isa Dict{String,Any} && haskey(m, "bridge_reply")
                deliver_reply!(m)
            else
                f(m)::Bool || return nothing
            end
        end
    end
end

"""
    drain(f)

Call `f` on each message that is there, without waiting: for the start of an export of a
program that has no task waiting in `recv`.
"""
function drain(f::F) where {F}
    for m in recv(; wait = false)
        f(m)
    end
    return nothing
end

end # module
