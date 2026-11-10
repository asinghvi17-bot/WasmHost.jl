"""
    WasmHostBridgeExt

The wait of [`WasmHost.Bridge.recv`](@ref) in a module compiled by WasmCodegen: a `julia_io`
external handle the page completes, waited for as a Julia task waits for a timer
(`Runtime.Host.await_handle`; in a program of one task, the module suspends in `poll`), and
cancelled by `Bridge.close`.
"""
module WasmHostBridgeExt

using WasmHost
import WasmCodegen

const Runtime = WasmCodegen.Runtime

WasmHost.Bridge.await_handle(h::Int32) = Runtime.Host.await_handle(h)
WasmHost.Bridge.close_handle(h::Int32) = Runtime.Host.close(h)
WasmHost.Bridge.cancel_handle(h::Int32) = (Runtime.JuliaIO.cancel(h); nothing)
WasmHost.Bridge.handle_message(h::Int32) = Runtime.Host.errmsg(h)

end # module
