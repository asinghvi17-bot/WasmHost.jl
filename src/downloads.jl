"""
    WasmHost.Downloads

HTTP requests performed by the host's `fetch`. The package extension `WasmHostDownloadsExt`
(loaded with Downloads and WasmCodegen) builds `Downloads.request` on [`request`](@ref) in the
compiled module, and [`request_all`](@ref) on [`request_batch`](@ref).

Protocol `wasm-fetch 1` (UTF-8 text, one field per line, no line breaks inside a field), in
`<spool>/<id>.req` and `<spool>/<id>.res`, or in the buffers of `wasm_host.http_request`:

    request:  "wasm-fetch 1", method, url, output path ("" = discard the body),
              input path ("" = no body), timeout in seconds ("inf"), then "name: value" headers
    response: "wasm-fetch 1", code (0 = a response, else a libcurl error code), error message,
              final url (after redirects), status, status line ("HTTP/1.1 200 OK"),
              then "name: value" headers of the final response (names in lower case)

How the program waits for the host:

- One request at a time (a program of one task, `WasmCodegen.Config(tasks = :none)`): the
  module suspends (JSPI) until the response is there. [`request_batch`](@ref) hands the host
  several requests at once, `wasm-fetch-batch 1`, which it performs together (one wait for
  all), in `<spool>/<id>.breq` and `<spool>/<id>.bres` or through `wasm_host.http_batch`:

      batch:    "wasm-fetch-batch 1", then for each request (response) its number of lines,
                then its lines

- As a Julia task (`tasks = :jspi`): the host starts the request and returns at once with a
  handle of WasmCodegen's `julia_io` events (opening `<spool>/<id>.hnd`, whose content is the
  handle, after writing `<id>.req`; or `wasm_host.http_start`), which it makes ready when the
  response is there (`<id>.res`; or `wasm_host.http_finish`). The task waits for the handle as
  for a timer (`Runtime.Host.await_handle`): the scheduler runs the other tasks meanwhile, and
  the module suspends only when every task waits, until one of their handles is ready. A host
  that can't start requests (no `julia_io` events given to the adapter) answers as before.
"""
module Downloads

using ..WasmHost: WasmHost, spool_dir, spool_path, spool_exchange, split_lines

const PROTOCOL = "wasm-fetch 1"
const BATCH_PROTOCOL = "wasm-fetch-batch 1"

"The outcome of a request (see the module's documentation)."
struct Result
    code::Int
    message::String
    url::String
    status::Int
    status_line::String
    headers::Vector{Pair{String,String}}
end

"A request: the arguments of [`request`](@ref)."
struct Request
    url::String
    method::String
    headers::Vector{Pair{String,String}}
    input::String
    output::String
    timeout::Float64
end

field(s::String, what::String) = WasmHost.field(s, PROTOCOL, what)

no_host(url::String, msg::String) = Result(2, string("wasm-fetch: ", msg), url, 0, "", Pair{String,String}[])
no_spool(url::String) = no_host(url, "the host provides no fetch (WASMHOST_SPOOL is not set)")
no_response(url::String) = no_host(url, "no response from the host (is its adapter installed?)")

"""
    request_text(url, method, headers, input, output, timeout) -> String

The text of a request. Throws an `ArgumentError` for a field with a line break.
"""
function request_text(url::String, method::String, headers::Vector{Pair{String,String}},
                      input::String, output::String, timeout::Float64)::String
    io = IOBuffer()
    println(io, PROTOCOL)
    println(io, field(method, "method"))
    println(io, field(url, "url"))
    println(io, field(output, "output path"))
    println(io, field(input, "input path"))
    println(io, isfinite(timeout) ? string(timeout) : "inf")
    for (k, v) in headers
        println(io, field(k, "header name"), ": ", field(v, "header value"))
    end
    return String(take!(io))
end

request_text(r::Request) = request_text(r.url, r.method, r.headers, r.input, r.output, r.timeout)

"""
    request(url, method, headers, input, output, timeout) -> Result

Perform the request through the host. `input`/`output` are paths of the program's filesystem
(\"\": none). Never throws for a failure of the request itself: that is `Result.code != 0`
(code 2 when the host has no fetch). In a module with Julia Tasks, only the calling task waits
(see the module's documentation).
"""
function request(url::String, method::String, headers::Vector{Pair{String,String}},
                 input::String, output::String, timeout::Float64)::Result
    isempty(spool_dir()) && return no_spool(url)
    text = request_text(url, method, headers, input, output, timeout)
    if concurrent()
        s = start(text)
        s === nothing || return parse_result(split_lines(finish!(s)), url)
    end
    res = exchange(text)
    res === nothing && return no_response(url)
    return parse_result(split_lines(res), url)
end

request(r::Request) = request(r.url, r.method, r.headers, r.input, r.output, r.timeout)

"The response text of a request, waiting for it (the module suspends); `nothing` if no host answered."
exchange(text::String)::Union{Nothing,String} =
    WasmHost.transport() === :import ? request_import(text) : spool_exchange(text, ".req", ".res")

"The response text for the request text, through the `wasm_host` import (defined by the extension)."
function request_import end

"The [`Result`](@ref) of the lines of a response; a malformed response is code 2."
function parse_result(lines::Vector{String}, url::String)::Result
    length(lines) >= 6 && lines[1] == PROTOCOL ||
        return no_host(url, "malformed response from the host")
    code = something(tryparse(Int, lines[2]), 2)
    status = something(tryparse(Int, lines[5]), 0)
    headers = Pair{String,String}[]
    for i in 7:length(lines)
        l = lines[i]
        j = findfirst(':', l)
        j === nothing && continue
        push!(headers, String(lowercase(l[1:prevind(l, j)])) => String(strip(l[nextind(l, j):end])))
    end
    return Result(code, lines[3], lines[4], status, lines[6], headers)
end

## several requests at once

"""
    request_batch(requests) -> Vector{Result}

Perform the requests together, their results in their order. In a program of one task: one
request to the host, which performs them all at once, and one wait (the module suspends until
the last response is there). In a module with Julia Tasks: each request started as
[`request`](@ref) starts it, then waited for in turn by the calling task alone. A host that
has neither performs them one after the other. Never throws for a failure of a request.
"""
function request_batch(reqs::Vector{Request})::Vector{Result}
    isempty(spool_dir()) && return Result[no_spool(r.url) for r in reqs]
    texts = String[request_text(r) for r in reqs]
    concurrent() && return request_started(reqs, texts)
    res = WasmHost.transport() === :import ? batch_import_lines(texts) : spool_batch(texts)
    # (a host without batches: one after the other)
    res === nothing && return Result[request(r) for r in reqs]
    return Result[parse_result(res[i], reqs[i].url) for i in eachindex(reqs)]
end

"The text of a batch of request texts (see the module's documentation)."
function batch_text(texts::Vector{String})::String
    io = IOBuffer()
    println(io, BATCH_PROTOCOL)
    for t in texts
        println(io, length(split_lines(t)))
        print(io, t)
    end
    return String(take!(io))
end

"The lines of each of the `n` responses of a batch's response text; `nothing` if it is malformed."
function parse_batch(s::String, n::Int)::Union{Nothing,Vector{Vector{String}}}
    lines = split_lines(s)
    (!isempty(lines) && lines[1] == BATCH_PROTOCOL) || return nothing
    out = Vector{String}[]
    i = 2
    while length(out) < n
        i <= length(lines) || return nothing
        k = tryparse(Int, lines[i])
        (k === nothing || k < 0 || i + k > length(lines)) && return nothing
        push!(out, lines[i+1:i+k])
        i += k + 1
    end
    return out
end

# the responses of a batch through the spool directory; `nothing` if no adapter answered
function spool_batch(texts::Vector{String})::Union{Nothing,Vector{Vector{String}}}
    res = spool_exchange(batch_text(texts), ".breq", ".bres")
    return res === nothing ? nothing : parse_batch(res, length(texts))
end

"The response texts of a batch, through the `wasm_host` import (defined by the extension); `nothing` if the host has none."
function batch_import end

function batch_import_lines(texts::Vector{String})::Union{Nothing,Vector{Vector{String}}}
    res = batch_import(texts)
    res === nothing && return nothing
    return Vector{String}[split_lines(t) for t in res]
end

## requests started by the host, waited for as a task (a module with tasks)

"""
    concurrent() -> Bool

Whether requests wait as Julia tasks: in a module compiled with `WasmCodegen.Config(tasks =
:jspi)` (the extension's method, `WasmCodegen.Runtime.Tasks.enabled()`), a constant of the
compilation. Natively, and in a program of one task, `false`.
"""
concurrent() = false

"A request the host has started: its `julia_io` handle, and its spool files' path without suffix (the spool transport)."
struct Started
    handle::Int32
    base::String
end

"""
    start(text) -> Union{Nothing,Started}

Have the host start the request, without waiting; `nothing` if it can't (then
[`exchange`](@ref) it). Release it with [`finish!`](@ref) (or [`abandon!`](@ref)).
"""
start(text::String)::Union{Nothing,Started} =
    WasmHost.transport() === :import ? import_start(text) : spool_start(text)

function import_start(text::String)::Union{Nothing,Started}
    h = start_import(text)
    return h > 0 ? Started(h, "") : nothing
end

# `<id>.req`, then `<id>.hnd`, whose opening starts the request and holds its handle; an
# adapter without `julia_io` events doesn't answer it (there is no such file)
function spool_start(text::String)::Union{Nothing,Started}
    base = spool_path("")
    write(base * ".req", text)
    h = nothing
    try
        h = tryparse(Int32, strip(read(base * ".hnd", String)))
    catch
        h = nothing
    end
    (h === nothing || h <= 0) || return Started(h, base)
    rm(base * ".req"; force = true)
    rm(base * ".hnd"; force = true)
    return nothing
end

"""
    finish!(s) -> String

Wait, as a task, for the started request `s`, and release it: its response text (`\"\"` when
the host gave none, a malformed response).
"""
function finish!(s::Started)::String
    out = nothing
    try
        await_handle(s.handle)
        if WasmHost.transport() === :import
            out = finish_import(s.handle)
        else
            try
                out = read(s.base * ".res", String)
            catch
                out = nothing
            end
        end
    finally
        abandon!(s)
    end
    return something(out, "")
end

"Release the started request `s` (its handle and its spool files); the host drops it if it still runs."
function abandon!(s::Started)
    close_handle(s.handle)
    if WasmHost.transport() !== :import
        rm(s.base * ".req"; force = true)
        rm(s.base * ".hnd"; force = true)
        rm(s.base * ".res"; force = true)
    end
    return nothing
end

# all started first, then each waited for in turn (those the host couldn't start, exchanged);
# what remains started when one throws, released
function request_started(reqs::Vector{Request}, texts::Vector{String})::Vector{Result}
    started = Union{Nothing,Started}[start(t) for t in texts]
    out = Vector{Result}(undef, length(reqs))
    try
        for i in eachindex(reqs)
            s = started[i]
            if s === nothing
                res = exchange(texts[i])
                out[i] = res === nothing ? no_response(reqs[i].url) : parse_result(split_lines(res), reqs[i].url)
            else
                started[i] = nothing
                out[i] = parse_result(split_lines(finish!(s)), reqs[i].url)
            end
        end
    finally
        for s in started
            s === nothing || abandon!(s)
        end
    end
    return out
end

# (the extension's methods: WasmCodegen's runtime and the `wasm_host` imports)
"`wasm_host.http_start`: the handle of the started request, or ≤ 0 when the host can't start one."
function start_import end
"`wasm_host.http_finish`: the response text of a started request that is ready; `nothing` if there is none."
function finish_import end
"Wait, as a task, until the `julia_io` handle is ready (WasmCodegen's `Runtime.Host.await_handle`)."
function await_handle end
"Release the `julia_io` handle (WasmCodegen's `Runtime.Host.close`)."
function close_handle end

## for programs

"""
    request_all(urls; outputs = nothing, method = nothing, headers = [], timeout = Inf,
                throw = true) -> Vector{Union{Downloads.Response,Downloads.RequestError}}

`Downloads.request` of each URL, all at once: `outputs[i]` (a path, an `IO` or `nothing`) is
the output of `urls[i]`; the other arguments are each request's. The results are in the order
of `urls`; with `throw`, the first failure (a `RequestError`) is thrown once all are done.

Natively it is `asyncmap` over `Downloads.request` (with Downloads loaded). In a module
compiled by WasmCodegen (`WasmHostDownloadsExt`) it is [`request_batch`](@ref): in a program of
one task (`tasks = :none`, where `@async` can't wait), the host performs them all in one
request; with tasks, as concurrent `Downloads.request`s.
"""
function request_all end

end # module Downloads
