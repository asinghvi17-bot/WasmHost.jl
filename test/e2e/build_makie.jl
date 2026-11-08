# julia --project=ENV build_makie.jl OUT.wasm — compile mprog.jl's MakieProg.main (tasks = :jspi, julia_io, verify = :error
# unless E2E_VERIFY=warn lists every error). `prepare()` runs natively first (WGLMakie's handler, the observables' closed world).
using Makie, WGLMakie, Observables
using WasmCodegen, WasmCompat, WasmHost
Base.get_extension(WasmHost, :WasmHostBridgeExt) === nothing && error("WasmHostBridgeExt is not loaded")
include(joinpath(@__DIR__, "mprog.jl"))
MakieProg.prepare()
verify = Symbol(get(ENV, "E2E_VERIFY", "error"))
cfg = WasmCodegen.Config(; host = :wasi, trim = :safe, on_unsupported = :error, verify, tasks = :jspi,
                         host_extensions = [:julia_io], shell_first_mutables = true)
t = time()
c = try
    WasmCodegen.compile([WasmCodegen.Entry(MakieProg.main, (); name = "main")]; config = cfg)
catch err
    println("COMPILE FAILED after ", round(time() - t; digits = 1), " s: ", typeof(err))
    open(ARGS[1] * ".errors.txt", "w") do io
        showerror(io, err)
    end
    exit(2)
end
println("compiled (makie, verify = $verify) in ", round(time() - t; digits = 1), " s: ", length(c.bytes), " bytes, peak RSS ",
        round(Sys.maxrss() / 2^20; digits = 0), " MiB, ", length(c.cgm.diagnostics), " diagnostics")
rep = isassigned(c.world.trim_report) ? c.world.trim_report[] : ""
isempty(rep) || write(ARGS[1] * ".verifier.txt", rep)
write(ARGS[1], c.bytes)
