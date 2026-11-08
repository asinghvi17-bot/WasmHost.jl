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

# a vector indexed from 0 (as an OffsetArray), for request_all
struct ZeroVec{T} <: AbstractVector{T}
    v::Vector{T}
end
Base.size(z::ZeroVec) = size(z.v)
Base.axes(z::ZeroVec) = (Base.IdentityUnitRange(0:length(z.v)-1),)
Base.getindex(z::ZeroVec, i::Int) = z.v[i+1]
Base.setindex!(z::ZeroVec, x, i::Int) = (z.v[i+1] = x)
Base.similar(z::ZeroVec, ::Type{T}, ax::Tuple{Base.IdentityUnitRange{UnitRange{Int}}}) where {T} =
    ZeroVec(Vector{T}(undef, length(ax[1])))

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
    # 4. request bodies: POST a String and bytes; a body without a method, a PUT
    echo = base() * "/echo-body"
    ios = [IOBuffer() for _ in 1:2]
    rs = WasmHost.Downloads.request_all([echo, echo]; outputs = ios, method = "POST",
                                        bodies = Union{String,Vector{UInt8}}["one body", UInt8[0x62, 0x79, 0x74, 0x65, 0x73]])
    for i in 1:2
        r = rs[i]
        say("B4 ", i, " ", r isa Downloads.Response ? r.status : -1, " ", String(take!(ios[i])))
    end
    io = IOBuffer()
    rs = WasmHost.Downloads.request_all([echo]; outputs = [io], bodies = ["x"])
    say("B4 put ", rs[1] isa Downloads.Response ? rs[1].status : -1, " ", String(take!(io)))
    # 5. urls indexed from 0: outputs and bodies indexed as them, and the results
    zurls = ZeroVec([echo, tile(2), tile(3)])
    zios = ZeroVec([IOBuffer() for _ in 1:3])
    zb = ZeroVec(Union{Nothing,String}["zero", nothing, nothing])
    rs = WasmHost.Downloads.request_all(zurls; outputs = zios, bodies = zb, method = "POST")
    say("B5 ", typeof(rs) <: ZeroVec, " ", first(axes(rs, 1)), ":", last(axes(rs, 1)))
    for i in eachindex(zurls)
        r = rs[i]
        b = take!(zios[i])
        say("B5 ", i, " ", r isa Downloads.Response ? r.status : -1, " ", length(b), " ", fnv(b))
    end
    return Int32(0)
end
end
