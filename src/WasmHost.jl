"""
    WasmHost

Host capabilities for Julia programs compiled to WebAssembly (WASI preview 1) by WasmCodegen:
what a WASI host doesn't provide, performed by the JavaScript host around the module. Natively
nothing changes.

- [`WasmHost.Downloads`](@ref): HTTP requests with the host's `fetch`. With Downloads and
  WasmCodegen loaded, the package extension `WasmHostDownloadsExt` makes `Downloads.request`
  (and so `Downloads.download`) use it in the compiled module.
- [`WasmHost.Decompress`](@ref): gzip, deflate and zstd decompression of a file by the host.
- [`WasmHost.Platform`](@ref): the host's platform tags, passed in the WASI environment.
- [`WasmHost.Bridge`](@ref): messages between the module and its page, in both directions (a
  Makie scene's browser events, a session's `evaljs`).

The Julia side doesn't know which host it runs on. Requests reach the host by one of two
transports (see [`transport`](@ref)):

- `:spool` (the default): files of a spool directory, `ENV["WASMHOST_SPOOL"]`, inside one of
  the WASI preopens. The program writes a request, `<spool>/<id>.<req>`, then opens the
  response, `<spool>/<id>.<res>`. The host adapter (e.g. `js/node/spool.mjs`) intercepts that
  `path_open`, does the work, writes the response file and lets the open proceed. The module
  imports only `wasi_snapshot_preview1`.
- `:import`: the import library `wasm_host` (e.g. `js/node/imports.mjs`), for a code generator
  that lets a program declare one (`Config(import_libraries = ["wasm_host"])`). Downloads only.

Paths in requests are the program's (WASI) paths; the host maps them through its preopens.
"""
module WasmHost

"""
    transport() -> Symbol

How HTTP requests reach the host: `:spool` (files of the spool directory; no import of its own)
or `:import` (the import library `wasm_host`). A build that uses the import library redefines it
before compiling, `WasmHost.transport() = :import`, and passes
`Config(import_libraries = ["wasm_host"])` to WasmCodegen. It is a function, not a setting read
at run time, so that the module contains only the transport it uses. Decompression always uses
the spool directory.
"""
transport() = :spool

"""
    spool_dir() -> String

The program's path of the spool directory, `ENV["WASMHOST_SPOOL"]` (or the older
`WASM_FETCH_SPOOL`), or `""` when the host has none.
"""
function spool_dir()::String
    s = get(ENV, "WASMHOST_SPOOL", "")
    return isempty(s) ? get(ENV, "WASM_FETCH_SPOOL", "") : s
end

const COUNTER = Ref(0)

"A fresh path in the spool directory, ending with `suffix`."
function spool_path(suffix::String)::String
    COUNTER[] += 1
    return joinpath(spool_dir(), string(COUNTER[], "-", string(rand(UInt32); base = 16), suffix))
end

"""
    spool_exchange(text, req_suffix, res_suffix) -> Union{Nothing,String}

Write `text` to a fresh `<spool>/<id><req_suffix>` and read `<spool>/<id><res_suffix>`, whose
opening makes the host adapter do the work. `nothing` when no adapter answered. Both files are
removed afterwards.
"""
function spool_exchange(text::String, req_suffix::String, res_suffix::String)::Union{Nothing,String}
    base = spool_path("")
    req, res = base * req_suffix, base * res_suffix
    write(req, text)
    out = nothing
    try
        # (the host does the work when the response file is opened)
        out = read(res, String)
    catch
        out = nothing
    finally
        rm(req; force = true)
        rm(res; force = true)
    end
    return out
end

# A field of a request: one line
function field(s::String, protocol::String, what::String)::String
    (occursin('\n', s) || occursin('\r', s)) &&
        throw(ArgumentError(string(protocol, ": the ", what, " contains a line break")))
    return s
end

# (`readlines` iterates with a function value: not in a trimmed program)
function split_lines(s::String)::Vector{String}
    v = String[String(l) for l in split(s, '\n')]
    !isempty(v) && isempty(v[end]) && pop!(v)
    return v
end

include("downloads.jl")
include("decompress.jl")
include("platform.jl")
include("bridge.jl")

end # module
