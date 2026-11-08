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
    bodies   :: Union{AbstractVector, Nothing} = nothing,
    method   :: Union{AbstractString, Nothing} = nothing,
    headers  :: Union{AbstractVector, AbstractDict} = Pair{String,String}[],
    timeout  :: Real = Inf,
    throw    :: Bool = true,
)
    WasmHost.Downloads.check_indices(urls, outputs, "outputs")
    WasmHost.Downloads.check_indices(urls, bodies, "bodies")
    out(i) = outputs === nothing ? nothing : outputs[i]
    function input(i)
        b = bodies === nothing ? nothing : WasmHost.Downloads.body_bytes(bodies[i])
        return b === nothing ? nothing : IOBuffer(b)
    end
    # A request with a body on a Downloader of its own: on a shared one (libcurl's multi handle), a large upload
    # among concurrent requests can make Downloads add a handle from within libcurl's callback
    # (`curl_multi_add_handle: 8`, CURLM_RECURSIVE_API_CALL), and that request never ends.
    dl(b) = b === nothing ? nothing : Downloads.Downloader()
    # (the indices of `urls`, whatever they are; the results indexed as `urls`)
    idx = collect(eachindex(urls))
    rs = asyncmap(idx) do i
        b = input(i)
        Downloads.request(urls[i]; input = b, output = out(i), method, headers, timeout, throw = false,
                          downloader = dl(b))
    end
    res = similar(urls, Union{Response, RequestError})
    for k in eachindex(idx)
        res[idx[k]] = rs[k]
    end
    if throw
        for r in res
            r isa RequestError && Base.throw(r)
        end
    end
    return res
end

end # module
