# EXPERIMENT (design question 2): Bonito's own Session in a Wasm module, with a connection that hands the bytes of
# Bonito's wire format to WasmHost.Bridge. `evaljs` on it, and an UpdateObservable coming back through `process_message`
# (the entry Bonito has for an already decoded frame). Compiled with verify = :warn to list what in Bonito does not
# compile as it is; the overlays below are the ones the first rounds needed. See deliverable/NOTES.md.
module SessionProg
using Bonito, Observables, WasmHost, WasmCodegen, UUIDs
using Bonito: @js_str

const B = WasmHost.Bridge
const WASM = WasmCodegen.Runtime.WASM_METHODS

struct WasmConnection <: Bonito.FrontendConnection end
Base.write(::WasmConnection, bytes::AbstractVector{UInt8}) = (B.send_frame(Vector{UInt8}(bytes)); nothing)
Base.isopen(::WasmConnection) = true
Base.close(::WasmConnection) = nothing
Bonito.setup_connection(::Bonito.Session{WasmConnection}) = nothing

say(xs...) = (println(Core.stdout, xs...); nothing)

# --- the overlays (Wasm only) ---------------------------------------------------------------------------------------
# 1. `Session()` draws its id from the OS (`uv_random`)
const UUID_COUNTER = Ref(UInt128(0))
Base.Experimental.@overlay WASM UUIDs.uuid4(rng::UUIDs.Random.AbstractRNG) = (UUID_COUNTER[] += 1; UUID(UUID_COUNTER[]))
Base.Experimental.@overlay WASM UUIDs.uuid4() = (UUID_COUNTER[] += 1; UUID(UUID_COUNTER[]))
# 2. `send(session, ::Dict{Symbol})` asks `session.ignore_message[]` (a `Function`-typed field): no export filter here
# 3. `process_message` reads `data["msg_type"]` as `Any`: its UpdateObservable branch, typed, and without the echo
#    `update_nocycle!` avoids with its `f isa JSUpdateObservable && continue`
const SUPPRESS = Ref(false)
Base.Experimental.@overlay WASM function (x::Bonito.JSUpdateObservable)(value)
    SUPPRESS[] && return nothing
    return invoke(x, Tuple{Any}, value)
end
function update_from_page!(session::Bonito.Session, data::Dict{String, Any})
    id = data["id"]::String
    root = Bonito.root_session(session)
    entry = get(session.session_objects, id, nothing)
    entry === nothing && session !== root && (entry = get(root.session_objects, id, nothing))
    obj = entry isa Bonito.CachedEntry ? entry.object : entry
    obj isa Observable{Any} || return nothing
    SUPPRESS[] = true
    try
        obj[] = data["payload"]
    finally
        SUPPRESS[] = false
    end
    return nothing
end
Base.Experimental.@overlay WASM function Bonito.process_message(session::Bonito.Session, data::Dict{String, Any})
    typ = data["msg_type"]::String
    typ == Bonito.UpdateObservable && return update_from_page!(session, data)
    return nothing
end

const OBS = Observable{Any}(0)
const GOT = Ref(0)
on(OBS) do v
    GOT[] += 1
end

function main()::Int32
    session = Bonito.Session(WasmConnection(); asset_server = Bonito.NoServer(), compression_enabled = false)
    put!(session.connection_ready, true)
    session.status = Bonito.OPEN
    # Julia -> page
    Bonito.evaljs(session, js"console.log('hello', $(OBS))")
    # page -> Julia (what Bonito's inbox task does with a frame)
    msg = Dict{String, Any}()
    msg["msg_type"] = Bonito.UpdateObservable
    msg["id"] = OBS.id
    msg["payload"] = 5
    Bonito.process_message(session, msg)
    say("S got ", GOT[])
    return Int32(0)
end

function prepare()
    CW = Main.WasmCompat.Observables
    CW.register_listener!(OBS, Bonito.JSUpdateObservable)
    CW.register_value!(OBS, Int64)
    CW.close_world!(Main.SessionProg, OBS)
end
end
