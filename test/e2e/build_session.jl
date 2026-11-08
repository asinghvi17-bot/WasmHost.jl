# julia --project=ENV build_session.jl OUT.wasm — the Session experiment (sprog.jl); verify = :warn lists every error
using WasmCodegen, WasmCompat, WasmHost, Bonito, Observables
Base.get_extension(WasmHost, :WasmHostBridgeExt) === nothing && error("WasmHostBridgeExt is not loaded")
include(joinpath(@__DIR__, "sprog.jl"))
SessionProg.prepare()
verify = Symbol(get(ENV, "E2E_VERIFY", "warn"))
cfg = WasmCodegen.Config(; host = :wasi, trim = :safe, on_unsupported = :warn, verify, tasks = :jspi, host_extensions = [:julia_io], shell_first_mutables = true)
t = time()
c = try
    WasmCodegen.compile([WasmCodegen.Entry(SessionProg.main, (); name = "main")]; config = cfg)
catch err
    println("COMPILE FAILED after ", round(time() - t; digits = 1), " s: ", typeof(err))
    open(ARGS[1] * ".errors.txt", "w") do io
        showerror(io, err)
    end
    exit(2)
end
println("compiled (session, verify = $verify) in ", round(time() - t; digits = 1), " s: ", length(c.bytes), " bytes, peak RSS ",
        round(Sys.maxrss() / 2^20; digits = 0), " MiB, ", length(c.cgm.diagnostics), " diagnostics")
rep = isassigned(c.world.trim_report) ? c.world.trim_report[] : ""
isempty(rep) || write(ARGS[1] * ".verifier.txt", rep)
write(ARGS[1], c.bytes)
