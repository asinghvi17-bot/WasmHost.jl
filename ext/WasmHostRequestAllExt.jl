# `WasmHost.Downloads.request_all` natively (with Downloads loaded): `asyncmap` over
# `Downloads.request`. In a module compiled by WasmCodegen, `WasmHostDownloadsExt`'s overlay
# replaces it with the host's batch.
module WasmHostRequestAllExt

using WasmHost
using Downloads
using Downloads: Response, RequestError

function WasmHost.Downloads.request_all(
    urls     :: AbstractVector{<:AbstractString};
    outputs  :: Union{AbstractVector, Nothing} = nothing,
    method   :: Union{AbstractString, Nothing} = nothing,
    headers  :: Union{AbstractVector, AbstractDict} = Pair{String,String}[],
    timeout  :: Real = Inf,
    throw    :: Bool = true,
) :: Vector{Union{Response, RequestError}}
    outputs === nothing || length(outputs) == length(urls) ||
        Base.throw(ArgumentError("request_all: $(length(outputs)) outputs for $(length(urls)) urls"))
    out(i) = outputs === nothing ? nothing : outputs[i]
    rs = asyncmap(i -> Downloads.request(urls[i]; output = out(i), method, headers, timeout, throw = false),
                  eachindex(urls))
    res = Union{Response, RequestError}[r for r in rs]
    if throw
        for r in res
            r isa RequestError && Base.throw(r)
        end
    end
    return res
end

end # module
