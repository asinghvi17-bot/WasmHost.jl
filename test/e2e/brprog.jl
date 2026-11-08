# The bridge's transport test: plain Julia that talks to its page through WasmHost.Bridge, compiled with
# `Config(tasks = :jspi)`. A task serves the page's messages (parked in `recv` while there are none) while main waits
# for it. Lines "R..." are what the page must see (JSON frames the module sent), in order.
module BridgeProg
using WasmHost, WasmCodegen

const B = WasmHost.Bridge

say(xs...) = (println(Core.stdout, xs...); nothing)

mutable struct State
    pings::Int
    sum::Float64
end

function handle(st::State, m)::Bool
    m isa Dict{String,Any} || return true
    t = get(m, "type", nothing)
    if t isa String && t == "ping"
        st.pings += 1
        v = get(m, "v", nothing)
        if v isa Vector{Float32}
            st.sum += sum(Float64, v)
        end
        reply = Dict{String,Any}("type" => "pong", "n" => st.pings, "sum" => st.sum, "arr" => Int32[1, 2, 3])
        reply["echo"] = get(m, "s", nothing)   # (a Pair of an Any value is not trim-safe: assign)
        B.send(reply)
        return true
    elseif t isa String && t == "stop"
        B.send(Dict{String,Any}("type" => "bye", "pings" => st.pings))
        return false
    end
    return true
end

function main()::Int32
    st = State(0, 0.0)
    B.send(Dict{String,Any}("type" => "hello", "msg" => "from julia é\n\"q\"", "x" => 1.5, "flag" => true, "none" => nothing))
    t = @async B.serve(m -> handle(st, m))
    try
        wait(t)
    catch e
        r = e isa TaskFailedException ? e.task.result : e
        say("R error ", WasmCodegen.Runtime.Host.error_text(r))
        return Int32(1)
    end
    say("R done ", st.pings, " ", st.sum)
    return Int32(0)
end
end
