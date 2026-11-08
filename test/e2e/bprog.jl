# The batch end-to-end program, for a program of one task (`Config(tasks = :none)`, where `@async` can't wait):
# `WasmHost.Downloads.request_all`, the host's batch (natively `asyncmap` over Downloads.request). Lines "B..." are
# compared with native; lines "time ..." are the wall times of the parts, in ms.
module BatchProg
using Downloads, WasmHost

say(xs...) = (println(Core.stdout, xs...); nothing)
base() = get(ENV, "FETCH_BASE", "http://127.0.0.1:8765")
outdir() = get(ENV, "FETCH_OUT", tempdir())
ntiles() = something(tryparse(Int, get(ENV, "CPROG_N", "14")), 14)
tile(i::Int) = string(base(), "/tile/", i)
refused() = "http://127.0.0.1:39917/nothing"
ms(t::Float64) = round(Int, 1000 * (time() - t))

function fnv(b::Vector{UInt8})
    h = 0xcbf29ce484222325
    for x in b
        h = (h ⊻ x) * 0x00000100000001b3
    end
    return string(h; base = 16)
end

function main()::Int32
    n = ntiles()
    urls = [tile(i) for i in 1:n]
    # 1. into IOBuffers
    ios = [IOBuffer() for _ in 1:n]
    t = time()
    rs = WasmHost.Downloads.request_all(urls; outputs = ios)
    say("time B1 ", ms(t))
    for i in 1:n
        r = rs[i]
        b = take!(ios[i])
        say("B1 ", i, " ", r isa Downloads.Response ? r.status : -1, " ", length(b), " ", fnv(b))
    end
    # 2. to files, with a 404 (a response: `request` doesn't throw for it) and a refused connection (a failure)
    us = vcat(urls, [base() * "/tile/missing", refused()])
    outs = Union{Nothing,String}[[joinpath(outdir(), string("btile-", i, ".bin")) for i in 1:n]; nothing; nothing]
    t = time()
    rs = WasmHost.Downloads.request_all(us; outputs = outs, throw = false)
    say("time B2 ", ms(t))
    for i in eachindex(us)
        r = rs[i]
        if r isa Downloads.Response
            say("B2 ", i, " ", r.status, " ", outs[i] === nothing ? "-" : string(filesize(outs[i])))
        else
            say("B2 ", i, " RequestError code=", r.code, " status=", r.response.status)
        end
    end
    # 3. throw = true: the failure thrown once all are done
    try
        WasmHost.Downloads.request_all([tile(1), refused()])
        say("B3 no error")
    catch e
        say("B3 ", e isa Downloads.RequestError ? string("RequestError code=", e.code, " status=", e.response.status) : "other error")
    end
    return Int32(0)
end
end
