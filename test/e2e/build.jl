# julia --project=ENV build.jl OUT.wasm [spool|import] [fetch|decompress|concurrent|batch]
# julia --project=ENV build.jl OUT.wasm [wasi|js] page
# Compile an e2e program for WASI: prog.jl's FetchProg.main (fetch), dprog.jl's
# DecompressProg.main (decompress), cprog.jl's ConcurrentProg.main (concurrent: Julia tasks,
# `tasks = :jspi`) or bprog.jl's BatchProg.main (batch: a program of one task); or pprog.jl's
# page messages, for WASI or for JavaScript. fetch, concurrent and batch are built with
# `verify = :error` (E2E_VERIFY: another).
using WasmCodegen, Downloads, WasmHost
Base.get_extension(WasmHost, :WasmHostDownloadsExt) === nothing && error("WasmHostDownloadsExt is not loaded")
out = ARGS[1]
transport = get(ARGS, 2, "spool")
program = get(ARGS, 3, "fetch")
if program == "page"
    # (WasmHost.Page over the import library `wasm_host_page`: WasmHostPageExt)
    Base.get_extension(WasmHost, :WasmHostPageExt) === nothing && error("WasmHostPageExt is not loaded")
    include(joinpath(@__DIR__, "pprog.jl"))
    P = PageProg
    entries = [WasmCodegen.Entry(transport == "js" ? P.main_send : P.main, (); name = transport == "js" ? "main_send" : "main"),
               WasmCodegen.Entry(P.bench_message, (Int32,); name = "bench_message"),
               WasmCodegen.Entry(P.bench_send, (); name = "bench_send")]
    cfg = WasmCodegen.Config(; host = transport == "js" ? :js : :wasi, trim = :safe, on_unsupported = :error,
                             verify = :error, import_libraries = ["wasm_host_page"])
    t = time()
    c = WasmCodegen.compile(entries; config = cfg)
    println("compiled (page, $transport) in ", round(time() - t; digits = 1), " s: ", length(c.bytes), " bytes")
    write(out, c.bytes)
    exit(0)
end
entry = if program == "fetch"
    include(joinpath(@__DIR__, "prog.jl")); FetchProg.main
elseif program == "concurrent"
    include(joinpath(@__DIR__, "cprog.jl")); ConcurrentProg.main
elseif program == "batch"
    include(joinpath(@__DIR__, "bprog.jl")); BatchProg.main
else
    include(joinpath(@__DIR__, "dprog.jl")); DecompressProg.main
end
kw = (;)
if transport == "import"
    # (needs a WasmCodegen with Config(import_libraries))
    @eval WasmHost transport() = :import
    kw = (; import_libraries = ["wasm_host"])
end
# (WasmHost.Platform.host_platform builds a BinaryPlatforms.Platform, whose constructor can parse
# version tags with a Regex: the host's regex engine, WasmCodegen's `julia_regex`)
program == "decompress" && (kw = (; kw..., host_extensions = [:julia_regex]))
# (Julia tasks: each on its own JSPI stack, on the host's events, julia_io)
program == "concurrent" && (kw = (; kw..., tasks = :jspi, host_extensions = [:julia_io]))
# (decompress needs the removed julia_regex: the trim verifier only warns for it)
verify = Symbol(get(ENV, "E2E_VERIFY", program in ("fetch", "concurrent", "batch") ? "error" : "warn"))
cfg = WasmCodegen.Config(; host = :wasi, trim = :safe, on_unsupported = :error, verify, kw...)
t = time()
c = WasmCodegen.compile([WasmCodegen.Entry(entry, (); name = "main")]; config = cfg)
println("compiled ($program, $transport, verify = $verify) in ", round(time() - t; digits = 1), " s: ", length(c.bytes), " bytes, peak RSS ",
        round(Sys.maxrss() / 2^20; digits = 0), " MiB, ",
        length(c.cgm.diagnostics), " diagnostics")
write(out, c.bytes)
