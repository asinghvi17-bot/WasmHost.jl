"""
    WasmHostPageExt

[`WasmHost.Page`](@ref) in modules compiled by WasmCodegen: methods of its overlay method table
(`WasmCodegen.Runtime.WASM_METHODS`) over the import library `wasm_host_page`, which the program
declares (`Config(import_libraries = ["wasm_host_page"])`). Natively `Page` stays its own (the
native queues).

`send` is one call: WasmCodegen copies a `Vector{UInt8}` or `String` argument of a declared
import to the linear memory and passes its offset and length (`WasmCodegen.IMPORT_BYTES`), for
`host = :wasi` and `host = :js`. `receive` copies the host's bytes in through WasmCodegen's
staging area (`Runtime.Staging`, internal, `host = :wasi`), in chunks of at most `Staging.CHUNK`
bytes, as `WasmHostDownloadsExt`'s import transport does: WasmCodegen's bytes arguments go one
way only, so a program for `host = :js` that receives does not compile.
"""
module WasmHostPageExt

import WasmHost
import WasmCodegen

const Page = WasmHost.Page
const Staging = WasmCodegen.Runtime.Staging

## sending (one call: WasmCodegen copies the bytes and passes their offset and length)

Base.Experimental.@overlay WasmCodegen.Runtime.WASM_METHODS WasmHost.Page.send(bytes::Vector{UInt8}) =
    (ccall((:send, "wasm_host_page"), Cvoid, (Vector{UInt8},), bytes); nothing)
Base.Experimental.@overlay WasmCodegen.Runtime.WASM_METHODS WasmHost.Page.send(s::String) =
    (ccall((:send, "wasm_host_page"), Cvoid, (String,), s); nothing)

## receiving (Staging: `host = :wasi`)

# bytes i + 1, ..., i + k of the host's next message into buf
function read_chunk!(buf::Vector{UInt8}, i::Int, k::Int)
    Staging.with_scope() do
        off = Staging.alloc_data(k; align = 1)
        ccall((:read, "wasm_host_page"), Cvoid, (UInt32, UInt32, UInt32), off, UInt32(i), UInt32(k))
        Staging.copy_from_linear!(buf, i + 1, off, k)
    end
    return nothing
end

Base.Experimental.@overlay WasmCodegen.Runtime.WASM_METHODS function WasmHost.Page.receive()::Union{Vector{UInt8},Nothing}
    n = Int(ccall((:pending, "wasm_host_page"), Int32, ()))
    n < 0 && return nothing
    buf = Vector{UInt8}(undef, n)
    i = 0
    while i < n
        k = min(n - i, Int(Staging.CHUNK))
        read_chunk!(buf, i, k)
        i += k
    end
    ccall((:pop, "wasm_host_page"), Cvoid, ())
    return buf
end

end # module
