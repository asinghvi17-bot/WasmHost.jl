# julia --project=ENV build_bridge.jl OUT.wasm [brprog]
# Compile the bridge's test program (tasks = :jspi, julia_io events, verify = :error unless E2E_VERIFY)
using WasmCodegen, WasmHost
Base.get_extension(WasmHost, :WasmHostBridgeExt) === nothing && error("WasmHostBridgeExt is not loaded")
include(joinpath(@__DIR__, "brprog.jl"))
out = ARGS[1]
verify = Symbol(get(ENV, "E2E_VERIFY", "error"))
cfg = WasmCodegen.Config(; host = :wasi, trim = :safe, on_unsupported = :error, verify, tasks = :jspi, host_extensions = [:julia_io])
t = time()
c = WasmCodegen.compile([WasmCodegen.Entry(BridgeProg.main, (); name = "main")]; config = cfg)
println("compiled (bridge, verify = $verify) in ", round(time() - t; digits = 1), " s: ", length(c.bytes), " bytes, peak RSS ",
        round(Sys.maxrss() / 2^20; digits = 0), " MiB, ", length(c.cgm.diagnostics), " diagnostics")
write(out, c.bytes)
