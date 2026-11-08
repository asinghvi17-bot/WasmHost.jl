# `Downloads.request` for modules compiled by WasmCodegen: a method of WasmCodegen's overlay
# method table (`Runtime.WASM_METHODS`), so the native method (libcurl) stays as it is in the
# build process while the module compiles this one. `Downloads.download` is Downloads' own: it
# calls `request`. Loaded when both Downloads and WasmCodegen are loaded, i.e. in any build
# process that compiles a program using Downloads.
#
# `Runtime.WASM_METHODS` is WasmCodegen's internal API today (it is how its own runtime replaces
# methods); this extension relies on it.
module WasmHostDownloadsExt

using WasmHost
using Downloads
using Downloads: Response, RequestError
import WasmCodegen

# (the host side of the requests: `WasmHost.Downloads`, not the stdlib)
const Host = WasmHost.Downloads

## the import transport (`WasmHost.transport() === :import`)

# `wasm_host.http_request(req, req_len, res, res_cap) -> len` with buffers in WasmCodegen's
# staging area of the linear memory (`Runtime.Staging`, also internal); needs
# `Config(import_libraries = ["wasm_host"])`
const Staging = WasmCodegen.Runtime.Staging
const RESPONSE_CAP = 1 << 16

function Host.request_import(text::String)::Union{Nothing,String}
    return Staging.with_scope() do
        n = sizeof(text)
        req = Staging.alloc_data(n; align = 1)
        Staging.copy_to_linear!(req, text, 1, n)
        res = Staging.alloc_data(RESPONSE_CAP; align = 1)
        len = ccall((:http_request, "wasm_host"), Int32, (UInt32, UInt32, UInt32, UInt32),
                    req, UInt32(n), res, UInt32(RESPONSE_CAP))
        len < 0 && return nothing
        buf = Vector{UInt8}(undef, len)
        Staging.copy_from_linear!(buf, 1, res, Int(len))
        return String(buf)
    end
end

# A text the host keeps for the module: `get(res, cap) -> len` writes it into `res` and returns
# its length, `-len` (nothing written) when `cap` is too small, 0 when there is none. (Each call
# in a staging scope of its own: no scope is open while a task waits, the arenas being shared by
# all tasks.)
function kept_text(get::F)::Union{Nothing,String} where {F}
    cap = RESPONSE_CAP
    while true
        r = kept_text(get, cap)
        r isa String && return r
        r == 0 && return nothing
        cap = Int(-r)
    end
end

# (a closure of its own: `cap` is not reassigned in it)
function kept_text(get::F, cap::Int)::Union{Int32,String} where {F}
    return Staging.with_scope() do
        res = Staging.alloc_data(cap; align = 1)
        len = get(res, UInt32(cap))::Int32
        len <= 0 && return len
        buf = Vector{UInt8}(undef, len)
        Staging.copy_from_linear!(buf, 1, res, Int(len))
        return String(buf)
    end
end

# `wasm_host.http_start(req, req_len, body, body_len) -> handle` (≤ 0: the host can't start
# requests), not suspending; `body_len` -1: no body. (An adapter that predates the body takes the
# first two arguments: a JavaScript function ignores the others.) `wasm_host.http_finish(h, res,
# res_cap) -> len`, the response once `h` is ready
function Host.start_import(text::String, body::Union{Nothing,Vector{UInt8}})::Int32
    return Staging.with_scope() do
        n = sizeof(text)
        req = Staging.alloc_data(n; align = 1)
        Staging.copy_to_linear!(req, text, 1, n)
        boff, blen = UInt32(0), Int32(-1)
        if body !== nothing
            blen = Int32(length(body))
            if blen > 0
                boff = Staging.alloc_data(blen; align = 1)
                Staging.copy_to_linear!(boff, body, 1, Int(blen))
            end
        end
        ccall((:http_start, "wasm_host"), Int32, (UInt32, UInt32, UInt32, Int32), req, UInt32(n), boff, blen)
    end
end

Host.finish_import(h::Int32)::Union{Nothing,String} =
    kept_text((res, cap) -> ccall((:http_finish, "wasm_host"), Int32, (Int32, UInt32, UInt32), h, res, cap))

# `wasm_host.http_batch(req, req_len) -> n` (suspending: the host performs the batch's requests
# together; < 0: it can't), then `wasm_host.http_batch_result(i, res, res_cap) -> len` of each
function Host.batch_import(texts::Vector{String})::Union{Nothing,Vector{String}}
    text = Host.batch_text(texts)
    n = Staging.with_scope() do
        len = sizeof(text)
        req = Staging.alloc_data(len; align = 1)
        Staging.copy_to_linear!(req, text, 1, len)
        ccall((:http_batch, "wasm_host"), Int32, (UInt32, UInt32), req, UInt32(len))
    end
    n == length(texts) || return nothing
    out = String[]
    for i in 0:Int32(n)-Int32(1)
        t = kept_text((res, cap) -> ccall((:http_batch_result, "wasm_host"), Int32, (Int32, UInt32, UInt32), i, res, cap))
        push!(out, something(t, ""))
    end
    return out
end

## waits as a task: WasmCodegen's runtime (`Runtime.Host`, `Runtime.Tasks`: internal API too)

const Runtime = WasmCodegen.Runtime

Host.await_handle(h::Int32) = Runtime.Host.await_handle(h)
Host.close_handle(h::Int32) = Runtime.Host.close(h)

# (a WasmCodegen without `Runtime.Tasks.enabled`: requests wait as in a program of one task)
@static if isdefined(Runtime, :Tasks) && isdefined(Runtime.Tasks, :enabled)
    Base.Experimental.@overlay Runtime.WASM_METHODS Host.concurrent() = Runtime.Tasks.enabled()
end

## Downloads.request

# (what the native method sends unless the caller sets one)
const USER_AGENT = Downloads.Curl.USER_AGENT

header_pairs(headers) = Pair{String,String}[String(k) => String(v) for (k, v) in headers]

# the request's body: a path of the program, or an IO copied to a spool file first
input_path(::Nothing) = ("", false)
input_path(path::AbstractString) = (String(abspath(path)), false)
function input_path(io::IO)
    p = WasmHost.spool_path(".in")
    open(f -> write(f, read(io)), p, "w")
    return (p, true)
end

# where the host writes the body: a path of the program, or a spool file copied into the IO
output_path(::Nothing) = ""
output_path(path::AbstractString) = String(abspath(path))
output_path(::IO) = WasmHost.spool_path(".out")

# the body into the output (for an IO), and its size in bytes
copy_body!(::Nothing, ::String) = 0
copy_body!(::AbstractString, p::String) = isfile(p) ? Int(filesize(p)) : 0
function copy_body!(io::IO, p::String)
    isfile(p) || return 0
    # (a loop, not an `open(...) do` closure: a counter it updated would be boxed)
    total = 0
    f = open(p)
    try
        buf = Vector{UInt8}(undef, 1 << 16)
        while !eof(f)
            n = readbytes!(f, buf)
            write(io, view(buf, 1:n))
            total += n
        end
    finally
        close(f)
    end
    return total
end

function scheme(url::String)
    i = findfirst(':', url)
    return i === nothing ? nothing : lowercase(url[1:prevind(url, i)])
end

# the Content-Length of the response, 0 without one (as libcurl's progress total)
function content_length(headers::Vector{Pair{String,String}})
    for (k, v) in headers
        k == "content-length" && return something(tryparse(Int, v), 0)
    end
    return 0
end

function request_method(method, input, output)::String
    return method === nothing ? (input !== nothing ? "PUT" : output !== nothing ? "GET" : "HEAD") :
           String(method)
end

function request_headers(headers)::Vector{Pair{String,String}}
    hdrs = header_pairs(headers)
    any(kv -> lowercase(kv[1]) == "user-agent", hdrs) || push!(hdrs, "User-Agent" => USER_AGENT)
    return hdrs
end

# the `Response` of a request's result, or its `RequestError`
function response_of(url::String, r::Host.Result)::Union{Response,RequestError}
    response = Response(r.code == 0 ? scheme(r.url) : nothing, r.code == 0 ? r.url : url,
                        r.status, r.status_line, r.headers)
    r.code == 0 && return response
    return RequestError(url, r.code, r.message, response)
end

function wasm_request(url::String, input, output, method, headers, timeout::Float64, progress,
                      throw::Bool)::Union{Response,RequestError}
    meth = request_method(method, input, output)
    hdrs = request_headers(headers)
    inp, in_tmp = input_path(input)
    out = output_path(output)
    local r::Host.Result
    nbytes = 0
    try
        r = Host.request(url, meth, hdrs, inp, out, timeout)
        r.code == 0 && (nbytes = copy_body!(output, out))
    finally
        in_tmp && rm(inp; force = true)
        output isa IO && rm(out; force = true)
    end
    if r.code == 0 && progress !== nothing
        # (one call, with the complete transfer: what libcurl's last progress call reports)
        progress(content_length(r.headers), nbytes, 0, 0)
    end
    res = response_of(url, r)
    throw && res isa RequestError && Base.throw(res)
    return res
end

Base.Experimental.@overlay WasmCodegen.Runtime.WASM_METHODS function Downloads.request(
    url        :: AbstractString;
    input      :: Union{Downloads.ArgRead, Nothing} = nothing,
    output     :: Union{Downloads.ArgWrite, Nothing} = nothing,
    method     :: Union{AbstractString, Nothing} = nothing,
    headers    :: Union{AbstractVector, AbstractDict} = Pair{String,String}[],
    timeout    :: Real = Inf,
    progress   :: Union{Function, Nothing} = nothing,
    verbose    :: Bool = false,
    debug      :: Union{Function, Nothing} = nothing,
    throw      :: Bool = true,
    downloader :: Union{Downloads.Downloader, Nothing} = nothing,
    interrupt  :: Union{Nothing, Base.Event} = nothing,
) :: Union{Response, RequestError}
    # (`verbose`, `debug`, `downloader` and `interrupt` have no meaning for the host's fetch)
    p = progress === nothing ? nothing :
        Downloads.p_func(progress, something(input, devnull), something(output, devnull))
    return wasm_request(String(url), input, output, method, headers, Float64(timeout), p, throw)
end

## WasmHost.Downloads.request_all: the host's batch (or, with tasks, concurrent requests)

Base.Experimental.@overlay WasmCodegen.Runtime.WASM_METHODS function Host.request_all(
    urls     :: AbstractVector{<:AbstractString};
    outputs  :: Union{AbstractVector, Nothing} = nothing,
    bodies   :: Union{AbstractVector, Nothing} = nothing,
    method   :: Union{AbstractString, Nothing} = nothing,
    headers  :: Union{AbstractVector, AbstractDict} = Pair{String,String}[],
    timeout  :: Real = Inf,
    throw    :: Bool = true,
)
    Host.check_indices(urls, outputs, "outputs")
    Host.check_indices(urls, bodies, "bodies")
    return wasm_request_all(urls, outputs, bodies, method, headers, Float64(timeout), throw)
end

# (the requests in the order of `eachindex(urls)`, the k-th of `urls[idx[k]]`; the results
# indexed as `urls`)
function wasm_request_all(urls, outputs, bodies, method, headers, timeout::Float64, throw::Bool)
    hdrs = request_headers(headers)
    idx = collect(eachindex(urls))
    reqs = Host.Request[]
    outs = String[]
    for i in idx
        o = outputs === nothing ? nothing : outputs[i]
        b = bodies === nothing ? nothing : bodies[i]
        out = output_path(o)
        push!(outs, out)
        push!(reqs, Host.Request(String(urls[i]), request_method(method, b, o), hdrs, "", out, timeout, b))
    end
    res = similar(urls, Union{Response,RequestError})
    try
        rs = Host.request_batch(reqs)
        for k in eachindex(idx)
            i = idx[k]
            o = outputs === nothing ? nothing : outputs[i]
            rs[k].code == 0 && copy_body!(o, outs[k])
            res[i] = response_of(reqs[k].url, rs[k])
        end
    finally
        for k in eachindex(idx)
            outputs !== nothing && outputs[idx[k]] isa IO && rm(outs[k]; force = true)
        end
    end
    if throw
        for r in res
            r isa RequestError && Base.throw(r)
        end
    end
    return res
end

## what else Downloads needs in a trimmed module

# `status_ok` looks its test up in a `Dict{String,Function}` (a call of a function value, which
# a trimmed program cannot make): the same table as code
Base.Experimental.@overlay WasmCodegen.Runtime.WASM_METHODS function Downloads.Curl.status_ok(
        proto::AbstractString, status::Integer)
    proto in ("http", "https", "ftp", "ftps", "dict", "pop3", "pop3s", "rtsp", "smtp", "smtps") &&
        return 200 <= status < 300
    proto in ("file", "ldap", "ldaps", "scp", "sftp") && return status == 0
    error("Downloads.jl doesn't know the correct request success criterion for ", proto)
end

# A `Downloader()` (made by programs that set an `easy_hook`) looks up the CA roots through
# NetworkOptions and a JLL's path (a `OncePerProcess`): TLS and its roots are the host's, so
# there are none here. The rest of `Downloader()` (a `Multi` without a libcurl handle, which is
# only made when a request is added) compiles as it is.
Base.Experimental.@overlay WasmCodegen.Runtime.WASM_METHODS Downloads.get_ca_roots() = nothing

end # module
