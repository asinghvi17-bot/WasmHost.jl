# The bridge's e2e program: plain Julia that talks to its page through WasmHost.Bridge, compiled with
# `Config(tasks = :jspi)` (build_bridge.jl). `ENV["BRIDGE_CASE"]` picks what it does (bdrive.mjs is the page's side of
# each, and checks it):
#
# - main: the codec's values, pings and pongs, a burst in order (and the page's queue overflowing), two asks at once
#   answered out of order, an ask the page fails (AskError), then `stop`: serve returns, which closes the bridge.
# - page-close: the page closes the bridge while an ask is pending and serve is parked: both end (BridgeClosedError).
# - serve-fails: the serve handler throws while an ask is pending: the ask fails, the bridge is closed.
# - module-close: `Bridge.close` from main while serve is parked: serve returns, the page is told, an ask after fails.
# - write-fails: the page's first write of the frames throws: the first recv fails, the frames stay queued, the
#   second recv gets them.
# - reentry (a browser): as main up to the pings; the page calls `poke` and `poke_recv` directly while main is
#   suspended, which the adapter's guard refuses (ReentryError, then InstancePoisonedError).
#
# What the module can't send any more (after the close) it prints, "R ..." lines on stdout.
module BridgeProg
using WasmHost, WasmCodegen

const B = WasmHost.Bridge

say(xs...) = (println(Core.stdout, xs...); nothing)
error_text(e) = WasmCodegen.Runtime.Host.error_text(e)
# (the exception of a failed task)
failure(e) = e isa TaskFailedException ? e.task.result : e

mutable struct State
    pings::Int
    sum::Float64
    seq::Int
    inorder::Bool
end

# an ask from a task of its own (a serve handler must not wait), whose answer (or error) the module sends back
function ask_and_tell(tag::String, request::Dict{String,Any})
    r = Dict{String,Any}("type" => "answer", "tag" => tag)
    try
        r["value"] = B.ask(request)
    catch e
        r["type"] = "ask-failed"
        r["error"] = e isa B.AskError ? "AskError" : e isa B.BridgeClosedError ? "BridgeClosedError" : "other"
        r["msg"] = e isa B.AskError ? e.msg : error_text(e)
    end
    B.send(r)
    return nothing
end

function handle(st::State, m)::Bool
    m isa Dict{String,Any} || return true
    t = get(m, "type", nothing)
    t isa String || return true
    if t == "ping"
        st.pings += 1
        v = get(m, "v", nothing)
        if v isa Vector{Float32}
            st.sum += sum(Float64, v)
        end
        reply = Dict{String,Any}("type" => "pong", "n" => st.pings, "sum" => st.sum, "arr" => Int32[1, 2, 3])
        reply["echo"] = get(m, "s", nothing)   # (a Pair of an Any value is not trim-safe: assign)
        B.send(reply)
    elseif t == "seq"
        n = get(m, "n", nothing)
        st.inorder &= n isa Int64 && n == st.seq + 1
        st.seq += 1
    elseif t == "seq-end"
        B.send((type = "seq-done", count = st.seq, inorder = st.inorder))
    elseif t == "ask2"
        @async ask_and_tell("first", Dict{String,Any}("op" => "add", "a" => 1, "b" => 2))
        @async ask_and_tell("second", Dict{String,Any}("op" => "add", "a" => 10, "b" => 20))
    elseif t == "askfail"
        @async ask_and_tell("fail", Dict{String,Any}("op" => "fail"))
    elseif t == "boom"
        error("boom")
    elseif t == "stop"
        B.send(Dict{String,Any}("type" => "bye", "pings" => st.pings))
        return false
    end
    return true
end

# the codec's values: what the page must decode. A NamedTuple of concretely typed fields (every one encoded by its
# type), and a Dict{String,Any} whose values are encoded by their type at run time (encode_any!'s list)
function hello(case::String)
    B.send((type = "hello", case = case, msg = "from julia é\n\"q\"", x = 1.5, flag = true, none = nothing,
            dict = Dict("x" => 1), bools = [true, false], tuple = (1, "x"), named = (a = 1.5, b = "s", c = Int64[1, 2]),
            f32 = Float32[1, 2, 3.5], sym = :sym, chars = ('a', 'é'),
            nested = Dict{String,Any}("v" => Any[1, "s", Dict("k" => 2.5), (1.0, 2.0)], "b" => Bool[true], "n" => nothing)))
    return nothing
end

function main()::Int32
    case = get(ENV, "BRIDGE_CASE", "main")
    st = State(0, 0.0, 0, true)
    if case == "write-fails"
        hello(case)
        try
            B.recv()
            say("R first recv: returned")
        catch e
            say("R first recv: ", error_text(e))
        end
        msgs = B.recv()
        m = msgs[1]
        got = Dict{String,Any}("type" => "got", "n" => length(msgs))
        got["first"] = m isa Dict{String,Any} ? get(m, "type", nothing) : nothing
        B.send(got)
        return Int32(0)
    end
    hello(case)
    signal = Channel{Bool}(1)
    t = @async B.serve(function (m)
        k = m isa Dict{String,Any} ? get(m, "type", nothing) : nothing
        if case == "module-close" && k isa String && k == "close-now"
            put!(signal, true)
            return true
        end
        return handle(st, m)
    end)
    if case == "main" || case == "reentry"
        try
            wait(t)
        catch e
            say("R serve failed: ", error_text(failure(e)))
            return Int32(1)
        end
        try
            B.send(Dict{String,Any}("type" => "after"))
            say("R send after close: sent")
        catch e
            say("R send after close: ", error_text(e))
        end
        say("R done ", st.pings, " ", st.sum)
        return Int32(0)
    elseif case == "page-close" || case == "serve-fails"
        a = @async begin
            try
                B.ask(Dict{String,Any}("op" => "hold"))
                say("R ask: answered")
            catch e
                say("R ask: ", error_text(e))
            end
        end
        try
            wait(t)
            say("R serve returned; open: ", B.isopen())
        catch e
            say("R serve failed: ", error_text(failure(e)), "; open: ", B.isopen())
        end
        wait(a)
        return Int32(0)
    elseif case == "module-close"
        take!(signal)
        B.close("closed by main")
        wait(t)
        say("R serve returned; open: ", B.isopen())
        try
            B.ask(Dict{String,Any}("op" => "late"))
            say("R ask after close: answered")
        catch e
            say("R ask after close: ", error_text(e))
        end
        return Int32(0)
    end
    say("R unknown case ", case)
    return Int32(2)
end

# (reentry: exports the page calls directly, bypassing promisingExports, while main is suspended)
function poke()::Int32
    B.send(Dict{String,Any}("type" => "poke"))
    return Int32(0)
end
function poke_recv()::Int32
    return Int32(length(B.recv(; wait = false)))
end
end
