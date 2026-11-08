# End-to-end checks: compile a program with WasmCodegen, run it in Node, Bun or a headless Chromium with WasmHost's
# adapter, and compare it with native.
#
#   julia test/e2e/e2e.jl /path/to/WasmCodegen.jl [spool|import|decompress|all]
#
# - spool, import: test/e2e/prog.jl (plain Downloads calls) against a local HTTP server
#   (server.mjs). Its output and downloaded bytes must equal the same program run natively
#   (Downloads + libcurl).
# - decompress: test/e2e/dprog.jl (WasmHost.Decompress and WasmHost.Platform) on a real
#   artifact tarball, gzip and zstd as the Pkg server serves it (and deflate). The decompressed
#   bytes must equal what native Pkg's own decompressors give (`get_extract_cmd`: 7z, zstd),
#   whose tree hash is the artifact's; the platform lines must equal the native run's.
#
# - WASM_RUNTIME=chromium: the browser adapter (js/browser/) in Playwright's headless Chromium, driven by Node
#   (test/e2e/browser/: `npm ci` and `npx playwright install chromium` there first). spool and import as above, with
#   the page on one origin and server.mjs on another (CORS); the browser sends its own User-Agent instead of
#   Downloads', so the native T3 body line is compared with the browser's User-Agent in it. decompress: the browser
#   adapter's decompression alone (browser/decompress.mjs), as dprog.jl needs WasmCodegen's julia_regex. spool and
#   import also call main twice at once through promisingExports (queued; rejected), and check the host guard.
#
# Environment: JULIA (default: this julia), WASM_RUNTIME (node, the default, bun or chromium), NODE (default: `node` on PATH,
# Node 22+ with JSPI; zstd needs 22.15+) or BUN (default: `bun` on PATH), WASMBUILDER / IRSTRUCTURIZER (paths, optional: otherwise WasmCodegen's own
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
driver = BROWSER ? "node" : runtime
node = get(ENV, uppercase(driver), something(Sys.which(driver), driver))
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

const NODE_FLAGS = runtime == "node" ? `--experimental-wasm-jspi --disable-warning=ExperimentalWarning` : ``

function build(env, wasm, transport, program)
    get(ENV, "E2E_REUSE", "") == "1" && isfile(wasm) && return
    run(`$julia --startup-file=no --project=$env $(joinpath(HERE, "build.jl")) $wasm $transport $program`)
end

# native's T lines, as the run must print them: in a browser, with the browser's User-Agent in the T3 body (server.mjs
# echoes the User-Agent; a browser's fetch sends its own instead of Downloads')
function expected(native, out)
    want = lines(native, "T")
    BROWSER || return want
    m = match(r"^user agent: (.*)$"m, out)
    m === nothing && return nothing
    return [startswith(l, "T3 body ") ? replace(l, r"ua=.*$" => "ua=" * m[1]) : l for l in want]
end

function downloads(env, transport)
    native = read(addenv(`$node $(joinpath(HERE, "native.mjs")) $(joinpath(work, "native"))`,
                         "JULIA" => julia, "E2E_PROJECT" => env), String)
    print("native:\n", native)
    ok = !isempty(lines(native, "T"))
    wasm = joinpath(work, "fetch-$transport.wasm")
    build(env, wasm, transport, "fetch")
    # (a browser: the spool transport waits with JSPI only)
    for mode in (transport == "import" ? ["import"] : BROWSER ? ["jspi"] : ["jspi", "sync"])
        out = BROWSER ? output(`$node $(joinpath(HERE, "browser", "run.mjs")) $wasm $mode $(joinpath(work, "chromium-$mode"))`) :
                        output(`$node $NODE_FLAGS $(joinpath(HERE, "run.mjs")) $wasm $mode $(joinpath(work, mode))`)
        skipped(out, "$transport/$mode") && continue
        same = lines(out, "T") == expected(native, out) && occursin("identical to the server's: true", out) &&
               occursin("spool files left: 0", out)
        println("== $transport/$mode: ", same ? "IDENTICAL to native" * (BROWSER ? " (the echoed User-Agent: the browser's)" : "") : "DIFFERENT", "\n", out)
        ok &= same
        BROWSER && (ok &= twice(wasm, mode, native))
    end
    return ok
end

# (a browser) main called twice at once through promisingExports: queued, the second runs after the first, and the
# output is native's twice, in order; rejected, the second fails with a ReentryError and the first is native's. With
# reject, the adapter's own guard of host jobs too.
function twice(wasm, mode, native)
    ok = true
    for how in ("queue", "reject")
        out = output(`$node $(joinpath(HERE, "browser", "run.mjs")) $wasm $mode $(joinpath(work, "chromium-$mode-$how")) $how`)
        want = expected(native, out)
        good = want !== nothing && occursin("main returned 0 ", out) && occursin("spool files left: 0", out) &&
               occursin("identical to the server's: true", out)
        if how == "queue"
            good &= lines(out, "T") == vcat(want, want) && occursin("second call: 0\n", out)
        else
            guard = lines(out, "host guard: ")
            good &= lines(out, "T") == want && occursin(r"^second call: rejected: ReentryError: "m, out) &&
                    length(guard) == 4 && all(endswith(": true"), guard)
        end
        println("== $mode, main twice at once ($how): ", good ? (how == "queue" ? "both IDENTICAL to native, one after the other" :
                                                                "the second REJECTED, the first IDENTICAL to native") : "WRONG", "\n", out)
        ok &= good
    end
    return ok
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

# (a browser: the adapter's decompression alone)
function browser_decompression()
    out = output(`$node $(joinpath(HERE, "browser", "decompress.mjs"))`)
    ok = occursin("DECOMPRESS PASS", out)
    println("== decompress/chromium (the adapter alone): ", ok ? "PASS" : "FAIL", "\n", out)
    return ok
end

function decompression(env)
    BROWSER && return browser_decompression()
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

# (the browser's decompress part compiles nothing)
env = BROWSER && which == "decompress" ? nothing : setup_env(joinpath(work, "env"))
ok = true
for part in (which == "all" ? ["spool", "import", "decompress"] : [which])
    global ok &= part == "decompress" ? decompression(env) : downloads(env, part)
end
println(ok ? "E2E PASS" : "E2E FAIL")
exit(ok ? 0 : 1)
