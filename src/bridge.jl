"""
    WasmHost.Bridge

A message channel between the module and the page, in both directions, for a program that has
to talk to its page after it has started: a Makie scene whose browser events (mouse, keys,
scroll, a picking reply) reach `events(scene)`, a session whose `evaljs` reaches the page.
Protocol `wasm-bridge 1`; see `docs/bridge.md` and `js/common/bridge.mjs` for the host's side.

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
- **Requests, [`ask`](@ref):** a task sends a request and parks until the page answers it
  (`{"bridge_reply": id, "value": v}`, or `"error"`: an [`AskError`](@ref)); [`serve`](@ref)
  delivers the answers.
- **The end, [`close`](@ref):** the module (`Bridge.close`, or [`serve`](@ref) ending) or the
  page (`bridge.close()`) closes the bridge: a parked `recv` wakes, it and every later `recv`,
  `send` and `ask` throw a [`BridgeClosedError`](@ref), and so do the pending asks.

A frame is `u32le header_length | header | blobs`. The header is JSON; a numeric vector
(`Vector{Float32}`, `Vector{Int32}`, ...) is in the blob region and the JSON holds
`{"\$b": [offset, bytes, "f32"]}` in its place (a typed array on the page). [`encode`](@ref)
and [`decode`](@ref) are the codec; see [`encode!`](@ref) for what it takes.
"""
module Bridge

using ..WasmHost: WasmHost, spool_dir, spool_path, spool_exchange

const PROTOCOL = "wasm-bridge 1"

"""
    BridgeError(message)

The host can't do what the program asked (no adapter bridge, a second pending `recv`, a page
whose `onMessage` threw), or a value the codec can't encode.
"""
struct BridgeError <: Exception
    msg::String
end
Base.showerror(io::IO, e::BridgeError) = print(io, "BridgeError: ", e.msg)

"""
    BridgeClosedError(reason)

The bridge is closed, by the module ([`close`](@ref), [`serve`](@ref) ending) or by the page
(`bridge.close(reason)`, the page going away): what a `recv`, `send` or `ask` throws then,
pending asks included. The end of the page's messages, as an `EOFError` is a stream's.
"""
struct BridgeClosedError <: Exception
    reason::String
end
Base.showerror(io::IO, e::BridgeClosedError) = print(io, "BridgeClosedError: the bridge is closed (", e.reason, ")")

"""
    AskError(id, message)

The page answered the request `id` of [`ask`](@ref) with an error (its `onAsk` threw or its
promise rejected: `{"bridge_reply": id, "error": message}`).
"""
struct AskError <: Exception
    id::Int64
    msg::String
end
Base.showerror(io::IO, e::AskError) = print(io, "AskError: the page failed request ", e.id, ": ", e.msg)

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

function write_string!(io::IOBuffer, s::AbstractString)
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
            write(io, Char(c))
        end
    end
    write(io, UInt8('"'))
    return nothing
end

# Blobs are 8-byte aligned in the blob region
function add_blob!(io::IOBuffer, blobs::IOBuffer, v::AbstractVector{T}) where {T<:BlobEltype}
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
    encode!(io, blobs, x)

Write `x` as JSON to `io`, and its numeric vectors to `blobs`. By the type of `x`:

- `nothing` and `missing` (`null`), `Bool`, any `Integer` (a number), any `AbstractFloat` (a
  number; `NaN` and `±Inf` are `null`), any `AbstractString`, `Symbol` and `AbstractChar` (a
  string);
- an `AbstractVector` of `Float32`, `Float64`, `Int8`, `UInt8`, `Int16`, `UInt16`, `Int32` or
  `UInt32`: a blob (a typed array on the page); any other `AbstractVector` (`[true, false]`,
  `Int64[...]`, `Any[...]`) and any `Tuple` (`(1, "x")`): an array;
- an `AbstractDict` with `AbstractString` or `Symbol` keys (`Dict("x" => 1)`) and a
  `NamedTuple`: an object.

The elements of a container are encoded by their type when the container's element type is
concrete (`Vector{Bool}`, `Dict{String,Int}`, a tuple's or named tuple's field types), so a
trimmed module resolves every call. An element whose declared type is not concrete (a
`Dict{String,Any}`'s values, a `Vector{Any}`'s, a `Union`) is encoded by its type at run time,
which must be one of a closed list ([`encode_any!`](@ref)). For the same reason, pass `send` a
value whose type the compiler knows: a value typed `Any` at the call (an element of what `recv`
returned) is sent in a container (`Dict{String,Any}("v" => x)`). A method of `encode!` for a
type of your own extends the codec for values of that (known) type. Anything else is a
[`BridgeError`](@ref).
"""
encode!(io::IOBuffer, ::IOBuffer, ::Union{Nothing,Missing}) = (write(io, "null"); nothing)
encode!(io::IOBuffer, ::IOBuffer, x::Bool) = (write(io, x ? "true" : "false"); nothing)
encode!(io::IOBuffer, ::IOBuffer, x::Integer) = (write(io, string(x)); nothing)
encode!(io::IOBuffer, ::IOBuffer, x::Union{Float64,Float32}) = (write(io, isfinite(x) ? string(x) : "null"); nothing)
encode!(io::IOBuffer, blobs::IOBuffer, x::AbstractFloat) = encode!(io, blobs, Float64(x))
encode!(io::IOBuffer, ::IOBuffer, x::AbstractString) = write_string!(io, x)
encode!(io::IOBuffer, ::IOBuffer, x::Symbol) = write_string!(io, String(x))
encode!(io::IOBuffer, ::IOBuffer, x::AbstractChar) = write_string!(io, string(Char(x)))
encode!(io::IOBuffer, blobs::IOBuffer, v::AbstractVector{T}) where {T<:BlobEltype} = add_blob!(io, blobs, v)

function encode!(io::IOBuffer, blobs::IOBuffer, v::AbstractVector)
    write(io, UInt8('['))
    first = true
    for y in v
        first || write(io, UInt8(','))
        first = false
        encode_as!(io, blobs, y, eltype(v))
    end
    write(io, UInt8(']'))
    return nothing
end

function encode!(io::IOBuffer, blobs::IOBuffer, t::Tuple)
    write(io, UInt8('['))
    encode_tuple!(io, blobs, t, true)
    write(io, UInt8(']'))
    return nothing
end
encode_tuple!(::IOBuffer, ::IOBuffer, ::Tuple{}, ::Bool) = nothing
function encode_tuple!(io::IOBuffer, blobs::IOBuffer, t::Tuple, first::Bool)
    first || write(io, UInt8(','))
    encode_as!(io, blobs, t[1], fieldtype(typeof(t), 1))
    return encode_tuple!(io, blobs, Base.tail(t), false)
end

function encode!(io::IOBuffer, blobs::IOBuffer, nt::NamedTuple)
    write(io, UInt8('{'))
    encode_fields!(io, blobs, keys(nt), Tuple(nt), true)
    write(io, UInt8('}'))
    return nothing
end
encode_fields!(::IOBuffer, ::IOBuffer, ::Tuple{}, ::Tuple{}, ::Bool) = nothing
function encode_fields!(io::IOBuffer, blobs::IOBuffer, ks::Tuple, vs::Tuple, first::Bool)
    first || write(io, UInt8(','))
    write_string!(io, String(ks[1]))
    write(io, UInt8(':'))
    encode_as!(io, blobs, vs[1], fieldtype(typeof(vs), 1))
    return encode_fields!(io, blobs, Base.tail(ks), Base.tail(vs), false)
end

function encode!(io::IOBuffer, blobs::IOBuffer, d::AbstractDict)
    write(io, UInt8('{'))
    first = true
    for (k, y) in d
        first || write(io, UInt8(','))
        first = false
        isconcretetype(keytype(d)) ? write_key!(io, k) : write_any_key!(io, k)
        write(io, UInt8(':'))
        encode_as!(io, blobs, y, valtype(d))
    end
    write(io, UInt8('}'))
    return nothing
end
write_key!(io::IOBuffer, k::AbstractString) = write_string!(io, k)
write_key!(io::IOBuffer, k::Symbol) = write_string!(io, String(k))
write_key!(::IOBuffer, k) = throw(BridgeError(string("a key of a dictionary must be a string or a symbol, not a ", typeof(k))))
function write_any_key!(io::IOBuffer, @nospecialize(k))
    if k isa String
        write_string!(io, k)
    elseif k isa Symbol
        write_string!(io, String(k))
    elseif k isa SubString{String}
        write_string!(io, k)
    else
        throw(BridgeError(string("a key of a dictionary must be a string or a symbol, not a ", typeof(k))))
    end
    return nothing
end

# anything else
encode!(io::IOBuffer, blobs::IOBuffer, x) = encode_other!(io, blobs, x)

# `y`, of the declared type `S` (a container's element type, a constant of the compiled method): by its type if `S` is
# concrete, else by its type at run time (encode_any!)
@inline encode_as!(io::IOBuffer, blobs::IOBuffer, y, ::Type{S}) where {S} =
    isconcretetype(S) ? encode!(io, blobs, y) : encode_any!(io, blobs, y)

"""
    encode_any!(io, blobs, x)

[`encode!`](@ref) of a value whose declared type is not concrete (an element of a
`Dict{String,Any}` or a `Vector{Any}`): by its type at run time, one of `nothing`, `missing`,
`Bool`, `Int8`...`Int64`, `UInt8`...`UInt64`, `Float32`, `Float64`, `String`,
`SubString{String}`, `Symbol`, `Char`; a `Vector` of those numbers, of `Any`, `String`,
`Symbol`, `Int64` or `Bool`; a `Dict{String}` or `Dict{Symbol}` of `Any`, a `Dict{String}` of
`String`, `Int64`, `Float64` or `Bool`; an `NTuple{N}` (`N` up to 4) of `Float64`, `Float32`,
`Int64` or `Int32`, a `Tuple{}`. Each is then encoded by its type; any other is a
[`BridgeError`](@ref) ([`encode_other!`](@ref)). A closed list, so that a trimmed module
resolves every call.
"""
function encode_any!(io::IOBuffer, blobs::IOBuffer, @nospecialize(x))
    if x === nothing || x === missing
        write(io, "null")
    elseif x isa Bool
        encode!(io, blobs, x)
    elseif x isa Int64
        encode!(io, blobs, x)
    elseif x isa Float64
        encode!(io, blobs, x)
    elseif x isa String
        encode!(io, blobs, x)
    elseif x isa Dict{String,Any}
        encode!(io, blobs, x)
    elseif x isa Vector{Any}
        encode!(io, blobs, x)
    elseif x isa Float32
        encode!(io, blobs, x)
    elseif x isa Int32
        encode!(io, blobs, x)
    elseif x isa Union{Int16,Int8}
        encode!(io, blobs, Int64(x))
    elseif x isa UInt64
        encode!(io, blobs, x)
    elseif x isa Union{UInt32,UInt16,UInt8}
        encode!(io, blobs, UInt64(x))
    elseif x isa SubString{String}
        encode!(io, blobs, x)
    elseif x isa Symbol
        encode!(io, blobs, x)
    elseif x isa Char
        encode!(io, blobs, x)
    elseif x isa Vector{Float32}
        encode!(io, blobs, x)
    elseif x isa Vector{Float64}
        encode!(io, blobs, x)
    elseif x isa Vector{UInt8}
        encode!(io, blobs, x)
    elseif x isa Vector{Int32}
        encode!(io, blobs, x)
    elseif x isa Vector{UInt32}
        encode!(io, blobs, x)
    elseif x isa Vector{Int16}
        encode!(io, blobs, x)
    elseif x isa Vector{UInt16}
        encode!(io, blobs, x)
    elseif x isa Vector{Int8}
        encode!(io, blobs, x)
    elseif x isa Vector{String}
        encode!(io, blobs, x)
    elseif x isa Vector{Symbol}
        encode!(io, blobs, x)
    elseif x isa Vector{Int64}
        encode!(io, blobs, x)
    elseif x isa Vector{Bool}
        encode!(io, blobs, x)
    elseif x isa Dict{Symbol,Any}
        encode!(io, blobs, x)
    elseif x isa Dict{String,String}
        encode!(io, blobs, x)
    elseif x isa Dict{String,Int64}
        encode!(io, blobs, x)
    elseif x isa Dict{String,Float64}
        encode!(io, blobs, x)
    elseif x isa Dict{String,Bool}
        encode!(io, blobs, x)
    elseif x isa Tuple{}
        write(io, "[]")
    elseif x isa NTuple{2,Float64}
        encode!(io, blobs, x)
    elseif x isa NTuple{3,Float64}
        encode!(io, blobs, x)
    elseif x isa NTuple{4,Float64}
        encode!(io, blobs, x)
    elseif x isa NTuple{2,Float32}
        encode!(io, blobs, x)
    elseif x isa NTuple{3,Float32}
        encode!(io, blobs, x)
    elseif x isa NTuple{4,Float32}
        encode!(io, blobs, x)
    elseif x isa NTuple{2,Int64}
        encode!(io, blobs, x)
    elseif x isa NTuple{3,Int64}
        encode!(io, blobs, x)
    elseif x isa NTuple{4,Int64}
        encode!(io, blobs, x)
    elseif x isa NTuple{2,Int32}
        encode!(io, blobs, x)
    elseif x isa NTuple{3,Int32}
        encode!(io, blobs, x)
    elseif x isa NTuple{4,Int32}
        encode!(io, blobs, x)
    else
        encode_other!(io, blobs, x)
    end
    return nothing
end

"""
    encode_other!(io, blobs, x)

A value the codec doesn't take (see [`encode!`](@ref)): a [`BridgeError`](@ref).
"""
encode_other!(::IOBuffer, ::IOBuffer, @nospecialize(x)) =
    throw(BridgeError(string("can't encode a ", typeof(x), " (see WasmHost.Bridge.encode!)")))

"""
    encode(x) -> Vector{UInt8}

The frame of `x` ([`encode!`](@ref) says what `x` may be).
"""
function encode(x)::Vector{UInt8}
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
                    if lo >= 0xdc00 && lo < 0xe000
                        u = 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00)
                    else
                        # (a high surrogate alone: U+FFFD, and the escape after it is its own character)
                        write(out, '\ufffd')
                        u = lo
                    end
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
    # (an empty blob is empty wherever it points: a frame whose blobs are all empty has no blob region)
    (off >= 0 && nbytes >= 0 && (nbytes == 0 || start + nbytes <= length(p.bytes))) || parse_error(p, "blob out of range")
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
        p.i <= length(p.bytes) || parse_error(p, "unterminated object")
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
        p.i <= length(p.bytes) || parse_error(p, "unterminated array")
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

# WASI errnos of the host's answers
const EBUSY = Int32(10)
const EIO = Int32(29)
const EPIPE = Int32(64)
# the message of a parked receive's handle when the page closed the bridge (js/common/bridge.mjs)
const CLOSED_PREFIX = "wasm-bridge closed: "

# the bridge's state in the module: closed (and why), a `recv` under way, and the handle of one parked for the page
# (0: none)
mutable struct State
    closed::Bool
    reason::String
    receiving::Bool
    parked::Int32
end
const STATE = State(false, "", false, Int32(0))

"""
The host's answer to a started `recv`: its handle (`0`: the frames are there already) or a negated errno, and the
answer's second line (EPIPE: why the bridge closed); `nothing` when no adapter bridge answered.
"""
function start_recv(base::String, wait::Bool)::Union{Nothing,Tuple{Int32,String}}
    write(base * ".rq", wait ? "wait" : "poll")
    text = ""
    try
        text = read(base * ".rcv", String)
    catch
        return nothing
    end
    nl = findfirst(==('\n'), text)
    h = tryparse(Int32, strip(nl === nothing ? text : text[1:prevind(text, nl)]))
    h === nothing && return nothing
    return (h, nl === nothing ? "" : String(text[nextind(text, nl):end]))
end

"Wait, as a task, until the `julia_io` handle is ready (WasmCodegen's `Runtime.Host.await_handle`)."
function await_handle end
"Release a `julia_io` handle."
function close_handle end
"Make a `julia_io` handle ready, cancelled (a parked `recv` wakes)."
function cancel_handle end
"The host's message of a `julia_io` handle (`Runtime.Host.errmsg`)."
function handle_message end

"""
    available() -> Bool

Whether the program has a spool directory (the adapter may still not have a bridge: [`send`](@ref)
returns `false` then).
"""
available() = !isempty(spool_dir())

"""
    isopen() -> Bool

Whether the bridge is open: not closed by the module ([`close`](@ref)) nor, as far as the module
has seen, by the page.
"""
isopen() = !STATE.closed

# closed: the pending asks fail. `false` if it was closed already
function mark_closed!(reason::String)::Bool
    STATE.closed && return false
    STATE.closed = true
    STATE.reason = reason
    for (_, ch) in PENDING
        isready(ch) || put!(ch, Failed(BridgeClosedError(reason)))
    end
    return true
end

closed_error() = BridgeClosedError(STATE.reason)

# the host's answer to a frame, or nothing (no adapter bridge)
exchange_frame(frame::Vector{UInt8})::Union{Nothing,String} = spool_exchange(String(copy(frame)), ".out", ".snd")

"""
    close(reason = "closed by the module")

Close the bridge: every pending [`ask`](@ref) fails with a [`BridgeClosedError`](@ref), a
`recv` parked for the page wakes and throws one (so [`serve`](@ref) returns), and so does every
later `recv`, `send` and `ask`; the page is told (its bridge's `onClose(reason, 'module')`; its
later posts throw). Closing a closed bridge does nothing. [`serve`](@ref) closes it when it ends.
"""
function close(reason::AbstractString = "closed by the module")
    r = String(reason)
    mark_closed!(r) || return nothing
    if !isempty(spool_dir())
        # (the page may be gone already, or have no bridge: nothing to tell then)
        try
            exchange_frame(encode(Dict{String,Any}("bridge_close" => r)))
        catch
        end
    end
    h = STATE.parked
    h > 0 && cancel_handle(h)
    return nothing
end

"""
    send_frame(frame) -> Bool

Hand the frame to the page. `false` if no adapter bridge took it; a [`BridgeError`](@ref) if
the page's `onMessage` threw, a [`BridgeClosedError`](@ref) if the bridge is closed.
"""
function send_frame(frame::Vector{UInt8})::Bool
    STATE.closed && throw(closed_error())
    isempty(spool_dir()) && return false
    ans = exchange_frame(frame)
    ans === nothing && return false
    ans == "ok" && return true
    if startswith(ans, "closed: ")
        mark_closed!(String(chopprefix(ans, "closed: ")))
        throw(closed_error())
    end
    throw(BridgeError(string("the page could not take the message: ", chopprefix(ans, "error: "))))
end

"""
    send(x) -> Bool

[`encode`](@ref) `x` and hand it to the page's `onMessage` (see [`send_frame`](@ref)).
"""
send(x) = send_frame(encode(x))

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
    i == length(buf) + 1 || throw(BridgeError("a truncated frame in the inbox"))
    return out
end

# the frames, or nothing when the bridge is closed
function receive(wait::Bool)::Union{Nothing,Vector{Vector{UInt8}}}
    STATE.closed && return nothing
    # (one at a time: refused here too, for the moment between the page's answer to one and its task's resuming)
    STATE.receiving && throw(BridgeError("another task is receiving already (one recv at a time: the task of Bridge.serve)"))
    STATE.receiving = true
    try
        return receive_one(wait)
    finally
        STATE.receiving = false
    end
end

function receive_one(wait::Bool)::Union{Nothing,Vector{Vector{UInt8}}}
    isempty(spool_dir()) && throw(BridgeError("no spool directory (the host gave none)"))
    base = spool_path("")
    answer = start_recv(base, wait)
    h = answer === nothing ? Int32(0) : answer[1]
    if answer === nothing || h < 0
        rm(base * ".rq"; force = true)
        rm(base * ".rcv"; force = true)
        answer === nothing && throw(BridgeError("the host adapter has no bridge"))
        if h == -EPIPE
            mark_closed!(isempty(answer[2]) ? "closed by the page" : answer[2])
            return nothing
        end
        h == -EBUSY && throw(BridgeError("another task is receiving already (one recv at a time: the task of Bridge.serve)"))
        h == -EIO && throw(BridgeError("the host could not write the page's messages (they stay queued on the page)"))
        throw(BridgeError(string("the host can't receive now (errno ", -h, ")")))
    end
    try
        if h > 0
            STATE.parked = h
            try
                await_handle(h)
            finally
                STATE.parked = Int32(0)
            end
            # (Bridge.close woke it)
            STATE.closed && return nothing
            if !isfile(base * ".inb")
                # (no frames: the handle's message says why)
                msg = handle_message(h)
                if startswith(msg, CLOSED_PREFIX)
                    mark_closed!(String(chopprefix(msg, CLOSED_PREFIX)))
                    return nothing
                end
                throw(BridgeError(string("the host could not deliver the page's messages (they stay queued on the page): ", msg)))
            end
        end
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
    recv_frames(; wait = true) -> Vector{Vector{UInt8}}

The frames the page has posted. With `wait`, waits (as a task, with `julia_io` events) until
there is at least one; without, returns what is there (possibly nothing). One `recv` at a time
(a second is a [`BridgeError`](@ref)). Throws a [`BridgeClosedError`](@ref) once the bridge is
closed, from either side (a parked `recv` wakes for it).
"""
function recv_frames(; wait::Bool = true)::Vector{Vector{UInt8}}
    frames = receive(wait)
    frames === nothing && throw(closed_error())
    return frames
end

"""
    recv(; wait = true) -> Vector{Any}

The values the page has posted, decoded, in the order it posted them (see
[`recv_frames`](@ref)).
"""
function recv(; wait::Bool = true)::Vector{Any}
    out = Any[]
    for f in recv_frames(; wait)
        push!(out, decode(f))
    end
    return out
end

## requests: a Julia task asks the page and parks until it answers (Bonito's `evaljs_value`, a pick)

# what a pending ask's channel gets instead of an answer: the ask's error
struct Failed
    err::Exception
end

const PENDING = Dict{Int64,Channel{Any}}()
const NEXT_REQUEST = Ref(Int64(0))

"""
    ask(request::AbstractDict) -> Any

Send `request` (a `Dict{String,Any}`, which gets a `"bridge_ask"` id; another dictionary is
copied into one) and wait, as a task (parked on a `Channel`: no handle of its own), until the
page answers with `{"bridge_reply": id, "value": ...}`, which [`serve`](@ref) (the task in
`recv`) delivers. The page's error answer (`{"bridge_reply": id, "error": message}`: on the
page, `onAsk` threw or rejected) is an [`AskError`](@ref); a bridge closed before the answer
(by either side, or by `serve` ending or failing) a [`BridgeClosedError`](@ref). Any number of
tasks may ask at once; each gets its own answer, in whatever order the page answers.

This is what Bonito's `evaljs_value` does with its `comm` observable, and a pick
(`WGLMakie.pick_native`...) is one: the asking task parks on the channel while the serving task
parks in `recv`'s host handle; the page's answer completes that handle, the serving task puts the
value in the channel, the asking task wakes. Needs a task in `serve`; not callable from the
serving task itself (its listener must `@async` the call, as WGLMakie's `on(comm)` does).
"""
function ask(request::Dict{String,Any})::Any
    STATE.closed && throw(closed_error())
    id = (NEXT_REQUEST[] += 1)
    ch = Channel{Any}(1)
    PENDING[id] = ch
    request["bridge_ask"] = id
    try
        send(request) || throw(BridgeError("no host bridge to ask"))
        v = take!(ch)
        v isa Failed && throw(v.err)
        return v
    finally
        delete!(PENDING, id)
    end
end
function ask(request::AbstractDict{<:Union{AbstractString,Symbol}})::Any
    d = Dict{String,Any}()
    for (k, v) in request
        d[String(k)] = v
    end
    return ask(d)
end

# an answer of the page: to the channel of its request (an unknown id, a request that gave up, a second answer: dropped)
function deliver_reply!(m::Dict{String,Any})
    id = get(m, "bridge_reply", nothing)
    id isa Int64 || return nothing
    ch = get(PENDING, id, nothing)
    (ch === nothing || isready(ch)) && return nothing
    err = get(m, "error", nothing)
    if err === nothing
        put!(ch, get(m, "value", nothing))
    else
        put!(ch, Failed(AskError(id, err isa String ? err : "(no message)")))
    end
    return nothing
end

"""
    serve(f)

Receive until `f(message)` returns `false` or the bridge is closed: the loop of a task that
serves the page's messages (`@async Bridge.serve(...)`), parked in `recv` while there are none.
Delivers the answers of [`ask`](@ref). Its end is the bridge's: when it returns, or when `f` or
a receive throws (the error propagates), it [`close`](@ref)s the bridge, so the pending asks
fail rather than wait for ever.
"""
function serve(f::F) where {F}
    reason = "Bridge.serve returned"
    try
        serve_loop(f)
    catch err
        reason = string("Bridge.serve failed: ", error_summary(err))
        rethrow()
    finally
        close(reason)
    end
    return nothing
end

# what an exception says, for the reason of a close (a closed list: no `showerror` of any type in a trimmed module)
function error_summary(@nospecialize(e))::String
    e isa BridgeError && return e.msg
    e isa BridgeClosedError && return string("closed (", e.reason, ")")
    e isa AskError && return e.msg
    if e isa ErrorException
        m = e.msg   # (an AbstractString field)
        return m isa String ? m : "an error"
    end
    return "an exception"
end

function serve_loop(f::F) where {F}
    while true
        msgs = receive(true)
        msgs === nothing && return nothing
        for frame in msgs
            m = decode(frame)
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
program that has no task waiting in `recv`. Throws a [`BridgeClosedError`](@ref) once the
bridge is closed.
"""
function drain(f::F) where {F}
    for m in recv(; wait = false)
        f(m)
    end
    return nothing
end

end # module
