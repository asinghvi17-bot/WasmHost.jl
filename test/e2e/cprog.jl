# The concurrent end-to-end program: plain Julia, Downloads calls in Julia tasks (@sync/@async, asyncmap, a task
# fetched later), nothing Wasm-specific. Compiled with `Config(tasks = :jspi)`, the requests overlap. Lines "C..." are
# compared with native; lines "time ..." are the wall times of the parts, in ms.
module ConcurrentProg
using Downloads

say(xs...) = (println(Core.stdout, xs...); nothing)
base() = get(ENV, "FETCH_BASE", "http://127.0.0.1:8765")
outdir() = get(ENV, "FETCH_OUT", tempdir())
ntiles() = something(tryparse(Int, get(ENV, "CPROG_N", "14")), 14)
tile(i::Int) = string(base(), "/tile/", i)
ms(t::Float64) = round(Int, 1000 * (time() - t))

# FNV-1a (64 bits) of the bytes, the same natively and in the module
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
    # 1. @sync/@async, each body into its IOBuffer
    ios = [IOBuffer() for _ in 1:n]
    t = time()
    @sync for i in 1:n
        @async Downloads.request(urls[i]; output = ios[i])
    end
    say("time C1 ", ms(t))
    for i in 1:n
        b = take!(ios[i])
        say("C1 ", i, " ", length(b), " ", fnv(b))
    end
    # 2. asyncmap, each to a file
    t = time()
    paths = asyncmap(i -> Downloads.download(urls[i], joinpath(outdir(), string("tile-", i, ".bin"))), 1:n)
    say("time C2 ", ms(t))
    for i in 1:n
        say("C2 ", i, " ", basename(paths[i]), " ", filesize(paths[i]))
    end
    # 3. tasks that wait on a fetch, fetched later while this task works
    t = time()
    tasks = [@async take!(Downloads.download(urls[i], IOBuffer())) for i in 1:3]
    acc = 0
    for k in 1:100_000
        acc += k % 7
    end
    got = [fetch(tk)::Vector{UInt8} for tk in tasks]
    say("time C3 ", ms(t))
    say("C3 ", acc, " ", join([string(length(b), ":", fnv(b)) for b in got], " "))
    # 4. a failure among concurrent requests: @sync throws a CompositeException of the task's failure
    try
        @sync begin
            @async Downloads.download(tile(1), IOBuffer())
            @async Downloads.download(base() * "/tile/missing", IOBuffer())
        end
        say("C4 no error")
    catch e
        if e isa CompositeException
            x = e.exceptions[1]
            r = x isa TaskFailedException ? x.task.result : x
            say("C4 CompositeException ", length(e.exceptions), " ",
                r isa Downloads.RequestError ? string("RequestError status=", r.response.status) : "other")
        else
            say("C4 other error")
        end
    end
    return Int32(0)
end
end
