# End-to-end checks: compile a program with WasmCodegen, run it in Node, Bun or a headless Chromium with WasmHost's
# adapter, and compare it with native.
#
#   julia test/e2e/e2e.jl /path/to/WasmCodegen.jl [spool|import|decompress|page|all]
#
# - spool, import: test/e2e/prog.jl (plain Downloads calls) against a local HTTP server
#   (server.mjs). Its output and downloaded bytes must equal the same program run natively
#   (Downloads + libcurl).
# - decompress: test/e2e/dprog.jl (WasmHost.Decompress and WasmHost.Platform) on a real
#   artifact tarball, gzip and zstd as the Pkg server serves it (and deflate). The decompressed
#   bytes must equal what native Pkg's own decompressors give (`get_extract_cmd`: 7z, zstd),
#   whose tree hash is the artifact's; the platform lines must equal the native run's.
# - page: test/e2e/pprog.jl (WasmHost.Page) for WASI, both directions, with the page adapter
#   (js/common/page.mjs, prun.mjs): its output and the messages it sends must equal the native
#   run's (pnative.jl). Then for JavaScript (`host = :js`, sending only).
# - WASM_RUNTIME=chromium: import only, with the browser adapter (js/browser/) in Playwright's headless Chromium,
#   driven by Node (test/e2e/browser/: `npm ci` and `npx playwright install chromium` there first). The test server
#   is on another origin than the page (CORS), and the browser sends its own User-Agent, which the native T3 body
#   line gets instead of Downloads'. Then browser/page.mjs's checkCalls: calls queued, a re-entrant call poisons.
#
# Environment: JULIA (default: this julia), WASM_RUNTIME (node, the default, bun or chromium), NODE (default: `node` on PATH,
# Node 24+, which has JSPI) or BUN (default: `bun` on PATH), WASMBUILDER / IRSTRUCTURIZER (paths, optional: otherwise WasmCodegen's own
# [sources]), E2E_REUSE=1 (run modules an earlier run built, without rebuilding them),
# E2E_ARTIFACTS (a directory with ARTIFACT.tar.gz and ARTIFACT.tar.zst, instead of downloading
# them from pkg.julialang.org).
# WasmCodegen needs the WASI filesystem and environment for `host = :wasi`; `import` also needs
# `Config(import_libraries)`, `decompress` the `julia_regex` host extension (for
# WasmHost.Platform.host_platform).
using TOML, Downloads, Tar, Pkg

const HERE = @__DIR__
const ROOT = dirname(dirname(HERE))
wcg = abspath(ARGS[1])
which = get(ARGS, 2, "spool")
julia = get(ENV, "JULIA", joinpath(Sys.BINDIR, Base.julia_exename()))
# the JavaScript runtime: WASM_RUNTIME=node (the default; NODE), bun (BUN) or chromium (driven by NODE)
runtime = get(ENV, "WASM_RUNTIME", "node")
runtime in ("node", "bun", "chromium") || error("WASM_RUNTIME must be node, bun or chromium, not $(repr(runtime))")
const BROWSER = runtime == "chromium"
BROWSER && which != "import" && error("e2e $which: not in chromium (the browser adapter has the import transport only)")
driver = BROWSER ? "node" : runtime
node = something(get(ENV, uppercase(driver), nothing), Sys.which(driver), Some(nothing))
node === nothing && error("$driver is not on PATH: install it (Node 24+ or Bun) or set $(uppercase(driver)) to its path")
work = mkpath(joinpath(HERE, "work"))

# a real artifact (Bzip2_jll's binaries for aarch64-linux-gnu; any artifact works): its tree hash
const ARTIFACT = "ffd5a7f2f7b63ef413accafeaaea298c49d4d2af"

# the environment: WasmCodegen, its WasmBuilder and IRStructurizer, WasmHost, Downloads
function setup_env(dir)
    wp = TOML.parsefile(joinpath(wcg, "Project.toml"))
    deps = Dict("WasmCodegen" => wp["uuid"], "WasmHost" => TOML.parsefile(joinpath(ROOT, "Project.toml"))["uuid"],
                "Downloads" => "f43a241f-c20a-4ad4-852c-f6b1247861c6")
    sources = Dict{String,Any}("WasmCodegen" => Dict("path" => wcg), "WasmHost" => Dict("path" => ROOT))
    for (name, var) in (("WasmBuilder", "WASMBUILDER"), ("IRStructurizer", "IRSTRUCTURIZER"))
        deps[name] = wp["deps"][name]
        src = haskey(ENV, var) ? Dict("path" => abspath(ENV[var])) : copy(wp["sources"][name])
        haskey(src, "path") && (src["path"] = abspath(wcg, src["path"]))
        sources[name] = src
    end
    mkpath(dir)
    # (a fresh resolve: an earlier run's manifest may point at another WasmCodegen)
    rm(joinpath(dir, "Manifest.toml"); force = true)
    open(io -> TOML.print(io, Dict("deps" => deps, "sources" => sources); sorted = true), joinpath(dir, "Project.toml"), "w")
    run(`$julia --startup-file=no --project=$dir -e "using Pkg; Pkg.instantiate()"`)
    return dir
end

lines(s, prefix) = filter(l -> startswith(l, prefix), split(s, '\n'))

# a run the runner skipped (an engine gap it names: `SKIP: …`), reported as such; with E2E_ALLOW_SKIP=0, a failure
function skipped(out, what)
    m = match(r"^SKIP: (.*)$"m, out)
    m === nothing && return false
    println("== $what: SKIPPED on $runtime, an engine gap: ", m[1])
    get(ENV, "E2E_ALLOW_SKIP", "1") == "1" || (global ok = false)
    return true
end

# the output of `cmd`, stdout and stderr together
function output(cmd)
    p = Pipe()
    proc = run(pipeline(ignorestatus(cmd); stdout = p, stderr = p); wait = false)
    close(p.in)
    out = read(p, String)
    wait(proc)
    return out
end

# (JSPI needs no flag: it is on by default in Node 24+, and Node 26 rejects --experimental-wasm-jspi as a "bad option")
const NODE_FLAGS = runtime == "node" ? `--disable-warning=ExperimentalWarning` : ``

function build(env, wasm, transport, program)
    get(ENV, "E2E_REUSE", "") == "1" && isfile(wasm) && return
    run(`$julia --startup-file=no --project=$env $(joinpath(HERE, "build.jl")) $wasm $transport $program`)
end

function downloads(env, transport)
    native = read(addenv(`$node $(joinpath(HERE, "native.mjs")) $(joinpath(work, "native"))`,
                         "JULIA" => julia, "E2E_PROJECT" => env), String)
    print("native:\n", native)
    ok = !isempty(lines(native, "T"))
    wasm = joinpath(work, "fetch-$transport.wasm")
    build(env, wasm, transport, "fetch")
    BROWSER && return ok & browser(wasm, native)
    for mode in (transport == "import" ? ["import"] : ["jspi", "sync"])
        out = output(`$node $NODE_FLAGS $(joinpath(HERE, "run.mjs")) $wasm $mode $(joinpath(work, mode))`)
        skipped(out, "$transport/$mode") && continue
        same = lines(out, "T") == lines(native, "T") && occursin("identical to the server's: true", out) &&
               occursin("spool files left: 0", out)
        println("== $transport/$mode: ", same ? "IDENTICAL to native" : "DIFFERENT", "\n", out)
        ok &= same
    end
    return ok
end

# (chromium) the module as native, but with the browser's User-Agent in the T3 body (server.mjs echoes it); then checkCalls
function browser(wasm, native)
    out = output(`$node $(joinpath(HERE, "browser", "run.mjs")) $wasm`)
    skipped(out, "import/chromium") && return true
    m = match(r"^user agent: (.*)$"m, out)
    want = [startswith(l, "T3 body ") && m !== nothing ? replace(l, r"ua=.*$" => "ua=" * m[1]) : l for l in lines(native, "T")]
    same = m !== nothing && lines(out, "T") == want && occursin("identical to the server's: true", out) &&
           occursin("spool files left: 0", out)
    println("== import/chromium: ", same ? "IDENTICAL to native (the echoed User-Agent: the browser's)" : "DIFFERENT", "\n", out)
    calls = output(`$node $(joinpath(HERE, "browser", "run.mjs")) $wasm calls`)
    good = occursin("CALLS PASS", calls)
    println("== import/chromium, calls: ", good ? "queued; the re-entrant call POISONED the instance" : "WRONG", "\n", calls)
    return same & good
end

# the compressed artifact, both encodings of the Pkg server
function artifacts()
    dir = mkpath(get(ENV, "E2E_ARTIFACTS", joinpath(work, "artifacts")))
    for (ext, accept) in (("gz", "gzip"), ("zst", "zstd, gzip"))
        f = joinpath(dir, "$ARTIFACT.tar.$ext")
        isfile(f) || Downloads.download("https://pkg.julialang.org/artifact/$ARTIFACT", f;
                                        headers = ["Accept-Encoding" => accept])
    end
    return dir
end

function decompression(env)
    src = artifacts()
    gz, zst = joinpath(src, "$ARTIFACT.tar.gz"), joinpath(src, "$ARTIFACT.tar.zst")
    # natively: Pkg's own decompressors (7z for gzip, zstd for zstd), checked by the tree hash
    fmts = (Pkg.PlatformEngines.detect_archive_format(gz), Pkg.PlatformEngines.detect_archive_format(zst))
    ref = read(Pkg.PlatformEngines.get_extract_cmd(gz))
    ok = fmts == ("gzip", "zstd") && read(Pkg.PlatformEngines.get_extract_cmd(zst)) == ref &&
         Tar.tree_hash(IOBuffer(ref)) == ARTIFACT
    println("native: formats $fmts; Pkg's decompressors agree, tree hash ", ARTIFACT, ": ", ok, "; ", length(ref), " bytes")
    indir = mkpath(joinpath(work, "dinput"))
    cp(gz, joinpath(indir, "artifact.tar.gz"); force = true)
    cp(zst, joinpath(indir, "artifact.tar.zst"); force = true)
    # (deflate, the zlib format: made from the native tar by node:zlib)
    write(joinpath(indir, "artifact.tar"), ref)
    run(`$node -e "const z=require('node:zlib'),fs=require('node:fs');fs.writeFileSync(process.argv[2],z.deflateSync(fs.readFileSync(process.argv[1])))" $(joinpath(indir, "artifact.tar")) $(joinpath(indir, "artifact.tar.zz"))`)
    rm(joinpath(indir, "artifact.tar"))
    # the platform tags both runs get
    platform = read(`$node --input-type=module -e "import { platformEnv } from $(repr("file://" * joinpath(ROOT, "js", "node", "platform.mjs"))); process.stdout.write(platformEnv({ cuda: 'none' }).WASMHOST_PLATFORM)"`, String)
    pnative = read(addenv(`$julia --startup-file=no --project=$env -e "include($(repr(joinpath(HERE, "dprog.jl")))); DecompressProg.platform_main()"`,
                          "WASMHOST_PLATFORM" => platform, "E2E_OLD_PLATFORM" => "arch=i686;os=windows"), String)
    print("native platform lines:\n", pnative)
    n = length(ref)
    want = ["D1 gzip ok true $n", "D2 zstd ok true $n", "D3 deflate ok true $n", "D4 gzip-explicit ok true $n",
            "D5 wrong-format DecompressError errno=25 no dst", "D6 not-compressed DecompressError errno=25 no dst",
            "D7 missing DecompressError errno=44 no dst"]
    wasm = joinpath(work, "decompress-spool.wasm")
    build(env, wasm, "spool", "decompress")
    for mode in ["jspi", "sync"]
        dir = joinpath(work, "d-$mode")
        out = output(addenv(`$node $NODE_FLAGS $(joinpath(HERE, "drun.mjs")) $wasm $mode $dir $indir $wcg`, "E2E_PLATFORM" => platform))
        skipped(out, "decompress/$mode") && continue
        bytes = [f => (isfile(joinpath(dir, "out", f)) && read(joinpath(dir, "out", f)) == ref) for f in ("gz.tar", "zst.tar", "zz.tar", "gz2.tar")]
        same = lines(out, "D") == want && all(last, bytes) && lines(out, "P") == lines(pnative, "P") &&
               occursin("spool files left: 0", out)
        println("== decompress/$mode: ", same ? "IDENTICAL to native" : "DIFFERENT", "; bytes equal to native: ", bytes, "\n", out)
        ok &= same
    end
    return ok
end

# page messages: for WASI, then for JavaScript (sending only)
function page(env)
    native = output(`$julia --startup-file=no --project=$env $(joinpath(HERE, "pnative.jl"))`)
    print("native:\n", native)
    want(prefix) = lines(native, prefix)
    ok = occursin("page check: true", native)
    for host in ("wasi", "js")
        wasm = joinpath(work, "page-$host.wasm")
        build(env, wasm, host, "page")
        out = output(`$node $(joinpath(HERE, "prun.mjs")) $wasm $host $(joinpath(wcg, "js", "julia.mjs"))`)
        same = occursin("page check: true", out) && lines(out, "S") == want("S") && lines(out, "U") == want("U") &&
               (host == "js" || lines(out, "R") == want("R"))
        println("== page/$host: ", same ? "IDENTICAL to native" : "DIFFERENT", "\n", out)
        ok &= same
    end
    return ok
end

env = setup_env(joinpath(work, "env"))
ok = true
for part in (which == "all" ? ["spool", "import", "decompress", "page"] : [which])
    global ok &= part == "decompress" ? decompression(env) : part == "page" ? page(env) : downloads(env, part)
end
println(ok ? "E2E PASS" : "E2E FAIL")
exit(ok ? 0 : 1)
