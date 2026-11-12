"""
    WasmHost.Decompress

Decompression of a file by the host: gzip and deflate on every host with an adapter, zstd where
the host has it. See [`decompress`](@ref).

Protocol `wasm-decompress 1`, in `<spool>/<id>.dreq` and `<spool>/<id>.dres` (always the spool
directory, whatever [`WasmHost.transport`](@ref) says):

    request:  "wasm-decompress 1", source path, destination path,
              format ("auto", "gzip", "deflate" or "zstd"; a missing line is "auto")
    response: "wasm-decompress 1", errno (WASI: 0 = done), message

`auto` recognizes gzip and zstd by their magic bytes, as Pkg's `detect_archive_format` does.
`deflate` is the zlib format (RFC 1950), as HTTP's and `DecompressionStream`'s "deflate".
"""
module Decompress

using ..WasmHost: WasmHost, spool_dir, spool_exchange, split_lines

const PROTOCOL = "wasm-decompress 1"

# WASI errno values the host answers with
const EACCES = 2
const EILSEQ = 25   # not data of the format (or of no format `auto` knows)
const EIO = 29      # failed while decompressing (corrupt data, a write error)
const ENOENT = 44   # no source file
const ENOSYS = 52   # the host can't do this (no adapter, or no decompressor for the format)

"""
    DecompressError(errno, message)

A decompression that didn't complete. `errno` is a WASI errno: `EILSEQ` (25) for data that
isn't of the format, `EIO` (29) for corrupt data or an I/O error, `ENOENT` (44) for a missing
source, `ENOSYS` (52) when the host can't decompress at all or not this format.
"""
struct DecompressError <: Exception
    errno::Int
    message::String
end

Base.showerror(io::IO, e::DecompressError) =
    print(io, "DecompressError: ", e.message, " (WASI errno ", e.errno, ")")

# (the protocol's names of the formats, as literals)
function format_name(format::Symbol)::String
    format === :auto && return "auto"
    format === :gzip && return "gzip"
    format === :deflate && return "deflate"
    format === :zstd && return "zstd"
    throw(ArgumentError("decompress: format must be :auto, :gzip, :deflate or :zstd"))
end

field(s::String, what::String) = WasmHost.field(s, PROTOCOL, what)

"The text of a request."
request_text(src::String, dst::String, format::String)::String =
    string(PROTOCOL, "\n", field(src, "source path"), "\n", field(dst, "destination path"), "\n", format, "\n")

"The errno and message of the lines of a response; a malformed response is `EIO`."
function parse_answer(lines::Vector{String})::Tuple{Int,String}
    (length(lines) >= 2 && lines[1] == PROTOCOL) || return (EIO, "malformed answer from the host")
    errno = something(tryparse(Int, lines[2]), EIO)
    return (errno, length(lines) >= 3 ? lines[3] : "")
end

"""
    decompress(src, dst; format = :auto) -> String

Decompress the file `src` into the file `dst` (replaced if it exists) and return `dst`'s
absolute path. `format` is `:auto` (gzip or zstd, by magic bytes), `:gzip`, `:deflate` or
`:zstd`. Throws a [`DecompressError`](@ref) when the host doesn't complete it; `dst` then
doesn't exist.

The host does the work through the spool directory. Without one (natively, or a host without
the adapter) this is `DecompressError(ENOSYS)`: a native program decompresses with its own
tools.
"""
function decompress(src::AbstractString, dst::AbstractString; format::Symbol = :auto)::String
    fmt = format_name(format)
    s, d = String(abspath(src)), String(abspath(dst))
    isempty(spool_dir()) &&
        throw(DecompressError(ENOSYS, "this host provides no decompression (WASMHOST_SPOOL is not set)"))
    text = spool_exchange(request_text(s, d, fmt), ".dreq", ".dres")
    if text === nothing
        rm(d; force = true)
        throw(DecompressError(ENOSYS, "no answer from the host (is its adapter installed?)"))
    end
    errno, msg = parse_answer(split_lines(text))
    if errno != 0
        rm(d; force = true)
        throw(DecompressError(errno, msg))
    end
    return d
end

end # module Decompress
