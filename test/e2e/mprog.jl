# The bridge with Makie: browser events reach `events(scene)` through WGLMakie's own `connect_scene_events!` (its
# `on(comm)` handler, unchanged), and a handler of `events(scene).mousebutton` runs in the module and answers the page
# with an evaljs-style message.
#
# What the page does for a WGLMakie figure is `comm.notify({mousedown: 1})` and the like (WGLMakie.js): Bonito sends an
# UpdateObservable message {msg_type: "0", id: comm.id, payload}. Here the page posts that message through the bridge;
# the serving task of the module looks up the observable by id and sets it. A Julia `@async` loop parked in `recv` is
# all it takes; the page never calls into the module.
module MakieProg
using Makie, WGLMakie, Observables, WasmHost, WasmCodegen

const B = WasmHost.Bridge
const WASM = WasmCodegen.Runtime.WASM_METHODS

# --- Wasm-only overlays (methods of WasmCodegen's overlay table: native code never sees them) ---------------------
# `Observable{Dict{String,Any}}`'s `isequal_closed` (WasmCompat) compiles `isequal` of two Dicts of Any, which is
# dynamic; it only runs for `ignore_equal_values = true`, which `comm` does not have.
Base.Experimental.@overlay WASM Base.isequal(a::Dict{String, Any}, b::Dict{String, Any}) = a === b
# `@warn ... exception = (err, catch_backtrace())` has no backtrace in Wasm
Base.Experimental.@overlay WASM WGLMakie.report_window_error(err) =
    (println(Core.stderr, "Error in window event callback: ", WasmCodegen.Runtime.Host.error_text(err)); nothing)
# `code_to_keyboard` builds a symbol and looks it up in `Keyboard` (a run-time `getfield`, and a Regex): the table of the
# JavaScript `KeyboardEvent.code` values it answers, made at build time by the function itself
const KEYS = Dict{String, Makie.Keyboard.Button}()
const KEYCODES = vcat(["Key" * string(c) for c in 'A':'Z'], ["Digit" * string(d) for d in 0:9],
                      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "Enter", "Escape", "Tab", "Backspace",
                       "Delete", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight",
                       "MetaLeft", "MetaRight", "Home", "End", "PageUp", "PageDown", "CapsLock", "Backquote", "Minus",
                       "Equal", "Comma", "Period", "Slash", "Semicolon", "Quote", "BracketLeft", "BracketRight",
                       "Backslash"], ["F" * string(i) for i in 1:12])
# the page's resize runs Makie's compute graph (`resize!` of a scene), whose static path is another task's: not here
Base.Experimental.@overlay WASM WGLMakie.resize_from_page!(scene::Scene, w::Int, h::Int) =
    (println(Core.stderr, "resize from the page: needs the ComputePipeline static path"); nothing)
Base.Experimental.@overlay WASM WGLMakie.code_to_keyboard(code::String) = get(KEYS, code, Makie.Keyboard.unknown)

say(xs...) = (println(Core.stdout, xs...); nothing)

const SCENE = Scene(size = (200, 150))
const EV = events(SCENE)
# what WGLMakie creates in `three_display` for the page's events, and registers on the session: `comm` is an
# Observable of a Dict, `connect_scene_events!` (WGLMakie/src/events.jl) listens to it
const COMM = Observable(Dict{String, Any}())
const SCREEN = WGLMakie.Screen(SCENE)

mutable struct Counts
    clicks::Int
    scrolls::Int
    moves::Int
    keys::Int
end
const COUNTS = Counts(0, 0, 0, 0)

# a Bonito-shaped message for the page: `evaljs(session, js"...")`
function evaljs_message(source::String)
    payload = Dict{String, Any}()
    payload["source"] = source
    payload["interpolated"] = Dict{String, Any}()
    msg = Dict{String, Any}()
    msg["msg_type"] = "2"          # Bonito.EvalJavascript
    msg["payload"] = payload
    return msg
end

# an `on(events(scene).mousebutton)` handler, the kind an interaction (a DataInspector, a drag) registers
function on_button(ev::Makie.MouseButtonEvent)
    COUNTS.clicks += 1
    pos = EV.mouseposition[]
    left = Makie.Mouse.left in EV.mousebuttonstate
    B.send(evaljs_message(string("console.log('julia saw ", ev.button, " ", ev.action, " at ", pos[1], ",", pos[2],
                                 " left-down=", left, " clicks=", COUNTS.clicks, "')")))
    return nothing
end

# a handler registered at run time (its type is declared at build time in `prepare`)
struct OnScroll end
function (::OnScroll)(s)
    COUNTS.scrolls += 1
    B.send(evaljs_message(string("console.log('julia saw scroll ", s[1], ",", s[2], " n=", COUNTS.scrolls, "')")))
    return nothing
end

on(on_button, EV.mousebutton)
on(_ -> (COUNTS.moves += 1; nothing), EV.mouseposition)
on(_ -> (COUNTS.keys += 1; nothing), EV.keyboardbutton)

# the session's `UpdateObservable` for the observables registered on it (here: `comm`)
function dispatch(m)::Bool
    m isa Dict{String, Any} || return true
    typ = get(m, "msg_type", nothing)
    typ isa String || return true
    if typ == "0"
        id = get(m, "id", nothing)
        payload = get(m, "payload", nothing)
        if id isa String && id == COMM.id && payload isa Dict{String, Any}
            COMM[] = payload
        end
    elseif typ == "stop"
        return false
    end
    return true
end

function main()::Int32
    on(OnScroll(), EV.scroll)
    # (what Bonito's registration of `comm` on the session tells the page: its id)
    hello = Dict{String, Any}()
    hello["msg_type"] = "hello"
    hello["comm"] = COMM.id
    B.send(hello)
    B.send(evaljs_message("console.log('julia ready: scene " * string(size(SCENE)[1]) * "x" * string(size(SCENE)[2]) * "')"))
    t = @async B.serve(dispatch)
    try
        wait(t)
    catch e
        say("R error ", WasmCodegen.Runtime.Host.error_text(e isa TaskFailedException ? e.task.result : e))
        return Int32(1)
    end
    say("R clicks=", COUNTS.clicks, " scrolls=", COUNTS.scrolls, " moves=", COUNTS.moves, " keys=", COUNTS.keys,
        " pos=", EV.mouseposition[][1], ",", EV.mouseposition[][2], " scroll=", EV.scroll[][1], ",", EV.scroll[][2],
        " pressed=", length(EV.mousebuttonstate), " window=", size(SCENE)[1], "x", size(SCENE)[2])
    return Int32(0)
end

# build time: WGLMakie's own handler of `comm`, and the closed world of the observables
function prepare()
    for code in KEYCODES
        KEYS[code] = WGLMakie.code_to_keyboard(code)
    end
    WGLMakie.connect_scene_events!(SCREEN, SCENE, COMM)
    # the scene's own compute graph (viewport, camera inputs), typed for the closed world
    Makie.ComputePipeline.StaticDispatch.install!(SCENE.compute)
    CW = Main.WasmCompat.Observables
    CW.register_listener!(EV.scroll, OnScroll)
    CW.register_value!(COMM, Dict{String, Any})
    CW.close_world!(Main.MakieProg, SCENE, COMM)
    return
end
end
