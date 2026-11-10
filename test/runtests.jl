# Native tests of the protocols and of the JavaScript adapter's parts (no WasmCodegen needed), the latter in Node or
# in Bun (WASM_RUNTIME).
# The end-to-end checks, which compile programs with WasmCodegen and run them in Node, are in
# test/e2e/e2e.jl.
using Test, WasmHost, Downloads
using WasmHost: split_lines, spool_dir
using WasmHost.Downloads: request_text, parse_result, Result, Request, batch_text, parse_batch, request_batch
using WasmHost.Decompress: DecompressError, decompress, parse_answer
using Base.BinaryPlatforms: HostPlatform, triplet, arch, os, libc

const JS = joinpath(dirname(@__DIR__), "js")
js(path...) = repr("file://" * joinpath(JS, path...))
# the JavaScript runtime of the adapter's tests: WASM_RUNTIME=node (the default; NODE) or bun (BUN)
const runtime = get(ENV, "WASM_RUNTIME", "node")
runtime in ("node", "bun") || error("WASM_RUNTIME must be node or bun, not $(repr(runtime))")
const node = something(get(ENV, uppercase(runtime), nothing), Sys.which(runtime), Some(nothing))
const NOSPOOL = ("WASMHOST_SPOOL" => nothing, "WASM_FETCH_SPOOL" => nothing)

# A vector indexed from 0 (OffsetArrays' kind, without the dependency), for request_all
struct ZeroVec{T} <: AbstractVector{T}
    v::Vector{T}
end
Base.size(z::ZeroVec) = size(z.v)
Base.axes(z::ZeroVec) = (Base.IdentityUnitRange(0:length(z.v)-1),)
Base.getindex(z::ZeroVec, i::Int) = z.v[i+1]
Base.setindex!(z::ZeroVec, x, i::Int) = (z.v[i+1] = x)
Base.similar(z::ZeroVec, ::Type{T}, ax::Tuple{Base.IdentityUnitRange{UnitRange{Int}}}) where {T} =
    ZeroVec(Vector{T}(undef, length(ax[1])))

# test/e2e/server.mjs on a free port, for `f(base)`; nothing without a JavaScript runtime
function with_server(f)
    p = open(`$node $(joinpath(@__DIR__, "e2e", "server.mjs")) 0`; read = true)
    try
        m = match(r"listening (\d+)", readline(p))
        return f("http://127.0.0.1:" * m[1])
    finally
        kill(p)
    end
end

@testset "WasmHost" begin
    @testset "spool directory" begin
        withenv(NOSPOOL...) do
            @test spool_dir() == ""
        end
        withenv("WASMHOST_SPOOL" => "/w/s", "WASM_FETCH_SPOOL" => "/w/old") do
            @test spool_dir() == "/w/s"
        end
        # (the older name, accepted)
        withenv("WASMHOST_SPOOL" => nothing, "WASM_FETCH_SPOOL" => "/w/old") do
            @test spool_dir() == "/w/old"
        end
        @test WasmHost.transport() === :spool
        @test split_lines("a\nb\n") == ["a", "b"]
        @test split_lines("a\n\nb") == ["a", "", "b"]
        @test split_lines("") == String[]
    end

    @testset "Downloads: request text" begin
        t = request_text("http://h/x", "GET", ["Accept" => "*/*", "X-A" => "b c"], "", "/w/out.bin", Inf)
        @test t == "wasm-fetch 1\nGET\nhttp://h/x\n/w/out.bin\n\ninf\nAccept: */*\nX-A: b c\n"
        @test split(request_text("u", "PUT", Pair{String,String}[], "/w/in", "", 2.5), '\n')[5:6] == ["/w/in", "2.5"]
        @test_throws ArgumentError request_text("http://h/\nx", "GET", Pair{String,String}[], "", "", Inf)
        @test_throws ArgumentError request_text("u", "GET", ["X" => "a\r\nY: b"], "", "", Inf)
    end

    @testset "Downloads: response parsing" begin
        lines = ["wasm-fetch 1", "0", "", "http://h/final", "200", "HTTP/1.1 200 OK",
                 "Content-Type: text/plain", "x-two:  spaced ", "no colon line", "set-cookie: a=1; Path=/"]
        r = parse_result(lines, "http://h/x")
        @test r isa Result
        @test (r.code, r.message, r.url, r.status, r.status_line) == (0, "", "http://h/final", 200, "HTTP/1.1 200 OK")
        @test r.headers == ["content-type" => "text/plain", "x-two" => "spaced", "set-cookie" => "a=1; Path=/"]
        e = parse_result(["wasm-fetch 1", "7", "connect ECONNREFUSED", "http://h/x", "0", ""], "http://h/x")
        @test (e.code, e.message, e.status, e.headers) == (7, "connect ECONNREFUSED", 0, Pair{String,String}[])
        # malformed: another protocol, too few lines
        @test parse_result(["wasm-fetch 2", "0", "", "u", "200", ""], "u").code == 2
        @test parse_result(["wasm-fetch 1", "0"], "u").code == 2
    end

    @testset "Downloads: without a host" begin
        # no spool directory: a failure of the request (code 2), not an exception
        withenv(NOSPOOL...) do
            r = WasmHost.Downloads.request("http://h/x", "GET", Pair{String,String}[], "", "", Inf)
            @test r.code == 2 && occursin("WASMHOST_SPOOL", r.message)
        end
        # a spool directory but no adapter answering it: code 2, and nothing left behind
        dir = mktempdir()
        withenv("WASMHOST_SPOOL" => dir) do
            r = WasmHost.Downloads.request("http://h/x", "GET", Pair{String,String}[], "", "", Inf)
            @test r.code == 2 && occursin("no response", r.message)
        end
        @test isempty(readdir(dir))
    end

    @testset "Downloads: request bodies" begin
        r = Request("http://h/a", "POST", Pair{String,String}[], "", "", Inf, "héllo")
        @test r.body == codeunits("héllo") && r.input == ""
        b = UInt8[1, 2, 3]
        r = Request("http://h/a", "POST", Pair{String,String}[], "", "", Inf, b)
        @test r.body == b && r.body !== b   # (a copy)
        # (any indices: by position)
        @test Request("u", "PUT", Pair{String,String}[], "", "", Inf, ZeroVec(UInt8[7, 8])).body == [7, 8]
        @test Request("u", "GET", Pair{String,String}[], "/w/in", "", Inf).body === nothing
        @test Request("u", "POST", Pair{String,String}[], "", "", Inf, UInt8[]).body == UInt8[]
        @test_throws ArgumentError Request("u", "POST", Pair{String,String}[], "/w/in", "", Inf, "x")
        # (the request text has no body; the body goes inline to http_start, or as a spool file named as the input)
        @test request_text(Request("u", "POST", Pair{String,String}[], "", "", Inf, "x")) == request_text("u", "POST", Pair{String,String}[], "", "", Inf)
        # without a host: no response, and the body's spool file not left behind
        dir = mktempdir()
        withenv("WASMHOST_SPOOL" => dir) do
            r = WasmHost.Downloads.request("http://h/x", "POST", Pair{String,String}[], "", "", Inf; body = "payload")
            @test r.code == 2 && occursin("no response", r.message)
            rs = request_batch([Request("http://h/a", "POST", Pair{String,String}[], "", "", Inf, "a"),
                                Request("http://h/b", "GET", Pair{String,String}[], "", "", Inf)])
            @test all(r -> r.code == 2, rs)
        end
        @test isempty(readdir(dir))
    end

    # natively (WasmHostRequestAllExt: asyncmap over Downloads.request) against test/e2e/server.mjs: urls of any
    # indices, the results indexed as them; POST bodies
    @testset "Downloads: request_all natively" begin
        if node === nothing
            @test_skip "$runtime not found"
        else
            with_server() do base
                urls = ZeroVec([base * "/echo-body", base * "/echo-body", base * "/hello.txt"])
                ios = ZeroVec([IOBuffer() for _ in 1:3])
                bodies = ZeroVec(Union{Nothing,String,Vector{UInt8}}["one body", UInt8[0x62, 0x79, 0x74, 0x65, 0x73], nothing])
                rs = WasmHost.Downloads.request_all(urls; outputs = ios, bodies, method = "POST")
                @test rs isa ZeroVec && axes(rs) == axes(urls)
                @test [r.status for r in rs.v] == [201, 201, 200]
                @test String(take!(ios[0])) == "POST 8 one body
"
                @test String(take!(ios[1])) == "POST 5 bytes
"
                @test occursin("Hello", String(take!(ios[2])))
                # a body and no method: a PUT, as Downloads.request with an input
                io = IOBuffer()
                rs = WasmHost.Downloads.request_all([base * "/echo-body"]; outputs = [io], bodies = ["x"])
                @test rs isa Vector && rs[1].status == 201 && String(take!(io)) == "PUT 1 x
"
                # without bodies, as before
                rs = WasmHost.Downloads.request_all([base * "/hello.txt", base * "/nothing"]; throw = false)
                @test [r.status for r in rs] == [200, 404]
                # concurrent bodies, a large one among them, after earlier ones (on a shared Downloader, natively, that
                # request never ends)
                big = repeat("abcdefgh", 75_000)
                batches = (["first", "second body"], ["first", "second body", big], [big, "x", big])
                t = @async map(batches) do bs
                    ios = [IOBuffer() for _ in bs]
                    WasmHost.Downloads.request_all(fill(base * "/echo-body", length(bs)); outputs = ios, bodies = bs, method = "POST")
                    [length(take!(io)) for io in ios]
                end
                for _ in 1:300
                    istaskdone(t) && break
                    sleep(0.1)
                end
                @test istaskdone(t) && !istaskfailed(t)
                # ("POST <n> <body>\n")
                istaskdone(t) && @test collect(fetch(t)) == [[sizeof(b) + 7 + ndigits(sizeof(b)) for b in bs] for bs in batches]
                # outputs or bodies indexed otherwise than the urls
                @test_throws ArgumentError WasmHost.Downloads.request_all(urls; outputs = [IOBuffer() for _ in 1:3])
                @test_throws ArgumentError WasmHost.Downloads.request_all(urls.v; bodies = ZeroVec(["a", "b", "c"]))
                @test_throws ArgumentError WasmHost.Downloads.request_all(urls.v; bodies = ["a"])
            end
        end
    end

    @testset "Downloads: batches" begin
        a = request_text("http://h/a", "GET", Pair{String,String}[], "", "/w/a", Inf)
        b = request_text("http://h/b", "HEAD", ["X" => "y"], "", "", 2.0)
        t = batch_text([a, b])
        @test t == "wasm-fetch-batch 1\n6\n" * a * "7\n" * b
        # a response of two results, one of no headers
        r1 = "wasm-fetch 1\n0\n\nhttp://h/a\n200\nHTTP/1.1 200 OK\ncontent-type: text/plain\n"
        r2 = "wasm-fetch 1\n7\nrefused\nhttp://h/b\n0\n\n"
        ls = parse_batch("wasm-fetch-batch 1\n7\n" * r1 * "6\n" * r2, 2)
        @test ls == [split_lines(r1), split_lines(r2)]
        @test parse_result(ls[1], "u").headers == ["content-type" => "text/plain"]
        @test parse_result(ls[2], "u").code == 7
        # malformed: another protocol, too few responses, a count beyond the end
        @test parse_batch("wasm-fetch-batch 2\n6\n" * r2, 1) === nothing
        @test parse_batch("wasm-fetch-batch 1\n6\n" * r2, 2) === nothing
        @test parse_batch("wasm-fetch-batch 1\n9\n" * r2, 1) === nothing
        # natively: no tasks, and no host
        @test WasmHost.Downloads.concurrent() === false
        reqs = [Request("http://h/a", "GET", Pair{String,String}[], "", "", Inf), Request("http://h/b", "GET", Pair{String,String}[], "", "", Inf)]
        withenv(NOSPOOL...) do
            rs = request_batch(reqs)
            @test length(rs) == 2 && all(r -> r.code == 2 && occursin("WASMHOST_SPOOL", r.message), rs)
            @test [r.url for r in rs] == ["http://h/a", "http://h/b"]
        end
        # a spool directory but no adapter: no batch, then each request, each without a response; nothing left
        dir = mktempdir()
        withenv("WASMHOST_SPOOL" => dir) do
            rs = request_batch(reqs)
            @test all(r -> r.code == 2 && occursin("no response", r.message), rs)
        end
        @test isempty(readdir(dir))
    end

    @testset "Decompress: protocol" begin
        D = WasmHost.Decompress
        @test D.request_text("/w/a.tar.gz", "/w/a.tar", "auto") == "wasm-decompress 1\n/w/a.tar.gz\n/w/a.tar\nauto\n"
        @test_throws ArgumentError D.request_text("/w/a\n", "/w/b", "auto")
        @test D.format_name(:zstd) == "zstd" && D.format_name(:deflate) == "deflate"
        @test_throws ArgumentError decompress("a", "b"; format = :bzip2)
        @test parse_answer(["wasm-decompress 1", "0", ""]) == (0, "")
        @test parse_answer(["wasm-decompress 1", "25", "not gzip data"]) == (25, "not gzip data")
        @test parse_answer(["wasm-decompress 1", "0"]) == (0, "")
        @test parse_answer(["wasm-decompress 2", "0", ""])[1] == D.EIO
        @test parse_answer(["wasm-decompress 1", "x", "m"]) == (D.EIO, "m")
        @test sprint(showerror, DecompressError(52, "no host")) == "DecompressError: no host (WASI errno 52)"
    end

    @testset "Decompress: without a host" begin
        dir = mktempdir()
        src, dst = joinpath(dir, "a.gz"), joinpath(dir, "a")
        write(src, "x"); write(dst, "old")
        withenv(NOSPOOL...) do
            e = try decompress(src, dst) catch e; e end
            @test e isa DecompressError && e.errno == 52 && occursin("WASMHOST_SPOOL", e.message)
        end
        spool = mkpath(joinpath(dir, "spool"))
        withenv("WASMHOST_SPOOL" => spool) do
            e = try decompress(src, dst) catch e; e end
            @test e isa DecompressError && e.errno == 52 && occursin("no answer", e.message)
        end
        # (nothing left behind; no destination after a failure)
        @test isempty(readdir(spool)) && !ispath(dst)
    end

    @testset "Platform" begin
        P = WasmHost.Platform
        @test P.parse_tags("arch=x86_64;os=linux;;libc=glibc;k=a=b") ==
              ["arch" => "x86_64", "os" => "linux", "libc" => "glibc", "k" => "a=b"]
        @test_throws ArgumentError P.parse_tags("arch=x86_64;nonsense")
        withenv("WASMHOST_PLATFORM" => nothing, "OLD_PLATFORM_VAR" => "arch=i686;os=windows") do
            @test P.tags() === nothing && P.host_platform() === nothing
            # (a variable of an older name, accepted when the program names it)
            @test P.tags(names = ("WASMHOST_PLATFORM", "OLD_PLATFORM_VAR")) == ["arch" => "i686", "os" => "windows"]
            @test triplet(P.host_platform(names = ("WASMHOST_PLATFORM", "OLD_PLATFORM_VAR"))) == "i686-w64-mingw32-julia_version+$VERSION"
        end
        # the native HostPlatform() through its tags: the same platform
        native = HostPlatform()
        tagstr = join(["$k=$v" for (k, v) in native.tags if k != "julia_version"], ';')
        withenv("WASMHOST_PLATFORM" => tagstr) do
            p = P.host_platform()
            @test p == native
            @test triplet(p) == triplet(native)
            @test p["julia_version"] == string(VERSION)
        end
        # versions normalized as the constructor does; julia_version is the program's own
        withenv("WASMHOST_PLATFORM" => "arch=x86_64;os=macos;os_version=14;julia_version=1.0.0") do
            p = P.host_platform()
            @test p["os_version"] == "14.0.0" && p["julia_version"] == string(VERSION)
        end
        withenv("WASMHOST_PLATFORM" => "os=linux") do
            @test_throws ArgumentError P.host_platform()
        end
        withenv("WASMHOST_PLATFORM" => "arch=x86_64;os=linux;validate_strict=true") do
            @test_throws ArgumentError P.host_platform()
        end
    end

    # the request as the JavaScript adapter parses it, and its response as Julia parses it
    @testset "JavaScript: downloads protocol round trip" begin
        if node === nothing
            @test_skip "$runtime not found"
        else
            req = request_text("http://h/x?a=1", "POST", ["X-Probe" => "v: w"], "/w/in", "/w/out", 3.0)
            script = """
            import { parseRequest, formatResult } from $(js("common", "fetch.mjs"));
            const req = parseRequest(process.argv.at(-1));
            process.stdout.write(formatResult({ code: 0, message: '', url: req.url + '#final', status: 201,
              statusLine: 'HTTP/1.1 201 Created', headers: [['x-echo', JSON.stringify([req.method, req.output, req.input, req.timeout, req.headers])]] }));
            """
            out = read(`$node --input-type=module -e $script $req`, String)
            r = parse_result(split_lines(out), "http://h/x?a=1")
            @test (r.code, r.url, r.status, r.status_line) == (0, "http://h/x?a=1#final", 201, "HTTP/1.1 201 Created")
            @test r.headers == ["x-echo" => """["POST","/w/out","/w/in",3,[["X-Probe","v: w"]]]"""]
        end
    end

    # a batch Julia writes, as the JavaScript adapter parses it, and its responses as Julia parses them
    @testset "JavaScript: batch round trip" begin
        if node === nothing
            @test_skip "$runtime not found"
        else
            texts = [request_text("http://h/$i", "GET", ["X-I" => string(i)], "", "/w/$i", Inf) for i in 1:3]
            script = """
            import { parseBatch, formatBatch, parseRequest, formatResult } from $(js("common", "fetch.mjs"));
            const reqs = parseBatch(process.argv.at(-1)).map(parseRequest);
            process.stdout.write(formatBatch(reqs.map((r, i) => formatResult({ code: 0, message: '', url: r.url, status: 200 + i,
              statusLine: 'HTTP/1.1 200 OK', headers: [['x-echo', r.output + ' ' + r.headers[0][1]]] }))));
            """
            out = read(`$node --input-type=module -e $script $(batch_text(texts))`, String)
            ls = parse_batch(out, 3)
            @test ls !== nothing
            rs = [parse_result(l, "u") for l in ls]
            @test [(r.url, r.status, r.headers) for r in rs] == [("http://h/$i", 199 + i, ["x-echo" => "/w/$i $i"]) for i in 1:3]
        end
    end

    # requests started without waiting, on julia_io events (a fake of WasmCodegen's, with external handles): the
    # handle at once, ready when the request is done; a closed handle aborts its request and drops its result; and the
    # Node adapter's imports http_start and http_finish on a memory (http_batch, which suspends: the e2e)
    @testset "JavaScript: started requests" begin
        if node === nothing
            @test_skip "$runtime not found"
        else
            script = """
            import { makeJobs, checkEvents } from $(js("common", "jobs.mjs"));
            import { makeImports } from $(js("node", "imports.mjs"));
            const out = [];
            const fake = () => {
              const hs = new Map(); let next = 1;
              return { hs, external({ onClose }) { const h = next++; hs.set(h, { ready: false, onClose }); return h; },
                       ready(h) { const x = hs.get(h); if (!x) return false; x.ready = true; return true; },
                       close(h) { const x = hs.get(h); hs.delete(h); x?.onClose?.(h); } };
            };
            let threw = false; try { checkEvents({}); } catch { threw = true; }
            out.push(['events without external handles refused', threw, checkEvents(undefined) === null]);
            const ev = fake(), stats = {};
            const jobs = makeJobs(ev, stats);
            let release, aborted = false;
            const h1 = jobs.start(() => new Promise((r) => { release = r; }));
            const h2 = jobs.start((signal) => new Promise((r) => signal.addEventListener('abort', () => { aborted = true; r('late'); })));
            out.push(['handles at once, not ready', h1 === 1 && h2 === 2 && !ev.hs.get(1).ready && stats.inFlight === 2]);
            await new Promise((r) => setTimeout(r, 0));   // (the jobs start in a microtask)
            release('one');
            await new Promise((r) => setTimeout(r, 10));
            out.push(['ready when done, the result kept', ev.hs.get(1).ready && jobs.result(1) === 'one']);
            ev.close(2);
            await new Promise((r) => setTimeout(r, 10));
            out.push(['a closed handle: aborted, dropped', aborted && jobs.result(2) === undefined && stats.inFlight === 0 && stats.maxInFlight === 2]);
            // the imports, on a memory, with a fetch that answers after a while
            const mem = new WebAssembly.Memory({ initial: 1 });
            const seen = [];
            const bodies = {};
            const fetchImpl = async (url, init) => { seen.push(url); bodies[url] = init?.body; await new Promise((r) => setTimeout(r, 20)); return new Response('x', { status: 203 }); };
            const ev2 = fake();
            const host = makeImports({ events: ev2, fetchImpl });
            host.bindMemory(mem);
            const put = (s, off) => { const b = new TextEncoder().encode(s); new Uint8Array(mem.buffer, off, b.length).set(b); return b.length; };
            const get = (off, n) => new TextDecoder().decode(new Uint8Array(mem.buffer, off, n));
            const req = (u) => ['wasm-fetch 1', 'GET', u, '', '', 'inf'].join('\\n') + '\\n';
            const t0 = performance.now();
            const ha = host.imports.wasm_host.http_start(0, put(req('http://h/a'), 0));
            const hb = host.imports.wasm_host.http_start(0, put(req('http://h/b'), 0));
            const started = performance.now() - t0;
            await new Promise((r) => setTimeout(r, 0));
            out.push(['http_start returns at once, both fetching', ha > 0 && hb > ha && started < 15 && seen.length === 2]);
            out.push(['http_finish before ready: 0', host.imports.wasm_host.http_finish(ha, 1024, 4096) === 0]);
            await new Promise((r) => setTimeout(r, 60));
            const n = host.imports.wasm_host.http_finish(hb, 1024, 4096);
            out.push(['http_finish once ready: the response', ev2.hs.get(hb).ready && n > 0 && get(1024, n).split('\\n')[4] === '203']);
            out.push(['http_finish into a small buffer: -length', host.imports.wasm_host.http_finish(ha, 1024, 4) === -n]);
            out.push(['without events: -ENOSYS', makeImports({}).imports.wasm_host.http_start(0, 0) === -52]);
            // a body, inline: copied at once (the module may reuse its buffer); -1: none; an empty one
            const hc = host.imports.wasm_host.http_start(0, put(req('http://h/c'), 0), 2048, put('payload', 2048));
            put('XXXXXXX', 2048);
            const hd = host.imports.wasm_host.http_start(0, put(req('http://h/d'), 0), 2048, -1);
            const he = host.imports.wasm_host.http_start(0, put(req('http://h/e'), 0), 2048, 0);
            await new Promise((r) => setTimeout(r, 60));
            out.push(['http_start with a body: sent, a copy', hc > 0 && new TextDecoder().decode(bodies['http://h/c']) === 'payload']);
            out.push(['http_start with body_len -1 or none: no body, an empty one: empty', bodies['http://h/d'] === undefined && bodies['http://h/a'] === undefined && bodies['http://h/e']?.length === 0]);
            process.stdout.write(out.map(([w, ...ok]) => w + ': ' + ok.every(Boolean)).join('\\n'));
            """
            res = split(read(`$node --input-type=module -e $script`, String), '\n')
            @test length(res) == 11
            for l in res
                @test endswith(l, ": true")
            end
        end
    end

    # the browser adapter's julia_io paths on the shim: status returns (path_chmod, path_symlink) are positive errnos,
    # ENOSYS (WasmCodegen's "a host without modes"), path_mode's a negated one
    @testset "JavaScript: browser julia_io paths" begin
        if node === nothing
            @test_skip "$runtime not found"
        else
            script = """
            import { makeShimJuliaIOPaths } from $(js("browser", "julia_io_paths.mjs"));
            const paths = makeShimJuliaIOPaths({ fds: [] });
            const mem = new WebAssembly.Memory({ initial: 1 });
            paths.bindMemory(mem);
            const b = new TextEncoder().encode('relative'); new Uint8Array(mem.buffer, 0, b.length).set(b);
            const { path_chmod, path_symlink, path_mode } = paths.imports;
            process.stdout.write([path_chmod(0, b.length, 0o700), path_symlink(0, 1, 0, b.length), path_mode(0, b.length, 1)].join(' '));
            """
            @test read(`$node --input-type=module -e $script`, String) == "52 52 -28"
        end
    end

    # the Node adapter's decompression of a request Julia writes, answered as Julia parses it
    @testset "JavaScript: decompression (node:zlib)" begin
        if node === nothing
            @test_skip "$runtime not found"
        else
            dir = mktempdir()
            data = repeat(collect(codeunits("WasmHost decompression test data. ")), 3000)
            write(joinpath(dir, "data"), data)
            write(joinpath(dir, "plain"), "not compressed at all")
            write(joinpath(dir, "bz"), UInt8[0x42, 0x5a, 0x68, 0x39, 0, 0])
            D = WasmHost.Decompress
            reqs = [(f, D.request_text(joinpath(dir, src), joinpath(dir, "out-" * f * "-" * fmt), fmt))
                    for (f, src, fmt) in [("gzip", "data.gz", "auto"), ("zstd", "data.zst", "auto"),
                                          ("deflate", "data.zz", "deflate"), ("gzip2", "data.gz", "gzip"),
                                          ("wrong", "data.gz", "zstd"), ("plain", "plain", "auto"),
                                          ("bzip2", "bz", "auto"), ("missing", "nothing-here", "auto"),
                                          ("corrupt", "corrupt.gz", "gzip")]]
            script = """
            import fs from 'node:fs'; import zlib from 'node:zlib'; import path from 'node:path';
            import { serve } from $(js("node", "spool.mjs"));
            import { parseDecompressRequest } from $(js("common", "decompress.mjs"));
            const [dir, ...reqs] = process.argv.slice(-$(1 + length(reqs)));
            const data = fs.readFileSync(path.join(dir, 'data'));
            fs.writeFileSync(path.join(dir, 'data.gz'), zlib.gzipSync(data));
            fs.writeFileSync(path.join(dir, 'data.zz'), zlib.deflateSync(data));
            if (zlib.zstdCompressSync) fs.writeFileSync(path.join(dir, 'data.zst'), zlib.zstdCompressSync(data));
            const gz = zlib.gzipSync(data); fs.writeFileSync(path.join(dir, 'corrupt.gz'), gz.subarray(0, gz.length >> 1));
            let i = 0;
            for (const text of reqs) {
              const d = parseDecompressRequest(text);
              const resHost = path.join(dir, 'answer-' + (i++));
              await serve({ kind: 'decompress', srcHost: d.src, dstHost: d.dst, format: d.format, resHost });
            }
            process.stdout.write(String(typeof zlib.zstdCompressSync === 'function'));
            """
            hasz = read(`$node --input-type=module -e $script $dir $(last.(reqs))`, String) == "true"
            answers = Dict(f => parse_answer(split_lines(read(joinpath(dir, "answer-$(i - 1)"), String)))
                           for (i, (f, _)) in enumerate(reqs))
            for f in ("gzip", "deflate", "gzip2")
                @test answers[f] == (0, "")
            end
            @test read(joinpath(dir, "out-gzip-auto")) == data
            @test read(joinpath(dir, "out-deflate-deflate")) == data
            if hasz
                @test answers["zstd"] == (0, "") && read(joinpath(dir, "out-zstd-auto")) == data
            else
                @test_skip "this Node has no zstd"
            end
            @test answers["wrong"] == (D.EILSEQ, "not zstd data")
            @test answers["plain"] == (D.EILSEQ, "unrecognized compression format")
            @test answers["bzip2"] == (D.ENOSYS, "bzip2: not supported by this host")
            @test answers["missing"][1] == D.ENOENT
            @test answers["corrupt"][1] == D.EIO && !ispath(joinpath(dir, "out-corrupt-gzip"))
            @test !ispath(joinpath(dir, "out-wrong-zstd"))
        end
    end

    # the Node adapter's detected tags make the native platform's arch, os and libc
    @testset "JavaScript: platform tags" begin
        if node === nothing
            @test_skip "$runtime not found"
        else
            script = """
            import { platformEnv } from $(js("node", "platform.mjs"));
            process.stdout.write(platformEnv({ cuda: 'none' }).WASMHOST_PLATFORM);
            """
            s = read(`$node --input-type=module -e $script`, String)
            withenv("WASMHOST_PLATFORM" => s) do
                p = WasmHost.Platform.host_platform()
                native = HostPlatform()
                @test (arch(p), os(p), libc(p)) == (arch(native), os(native), libc(native))
                @test p["cuda"] == "none"
            end
        end
    end
    @testset "Bridge: codec" begin
        B = WasmHost.Bridge
        rt(x) = B.decode(B.encode(x))
        # plain values: any dictionary, vector or tuple of them
        @test rt(Dict("x" => 1)) == Dict{String,Any}("x" => 1)
        @test rt([true, false]) == Any[true, false]
        @test rt((1, "x")) == Any[1, "x"]
        @test rt((a = 1.5, b = "s", c = (x = nothing,))) == Dict{String,Any}("a" => 1.5, "b" => "s", "c" => Dict{String,Any}("x" => nothing))
        @test rt(Dict(:k => [1, 2])) == Dict{String,Any}("k" => Any[1, 2])
        @test rt(Dict{String,Any}("v" => Any[1, "s", Dict("k" => 2.5), (1.0, 2.0), :sym, 'c', nothing])) ==
              Dict{String,Any}("v" => Any[1, "s", Dict{String,Any}("k" => 2.5), Any[1.0, 2.0], "sym", "c", nothing])
        @test rt(1:3) == Any[1, 2, 3]
        @test rt("é\n\"q\"\t\u0001") == "é\n\"q\"\t\u0001"
        @test rt(Float16(1.5)) === 1.5 && rt(NaN) === nothing && rt(UInt8(7)) === 7
        # numeric vectors are blobs (typed arrays on the page), views and ranges of them too
        @test rt(Float32[1, 2.5]) == Float32[1, 2.5] && rt(Float32[1, 2.5]) isa Vector{Float32}
        @test rt(view(Int32[1, 2, 3], 2:3)) == Int32[2, 3] && rt(view(Int32[1, 2, 3], 2:3)) isa Vector{Int32}
        @test rt(Dict{String,Any}("a" => UInt16[1, 2], "b" => Float64[])) == Dict{String,Any}("a" => UInt16[1, 2], "b" => Float64[])
        # what it can't take: a BridgeError
        @test_throws B.BridgeError B.encode(Dict(1 => 2))
        @test_throws B.BridgeError B.encode(1 + 2im)
        @test_throws B.BridgeError B.encode(Any[1 + 2im])
        @test_throws B.BridgeError B.decode(UInt8[1, 0])
        @test_throws B.BridgeError B.split_frames(UInt8[5, 0, 0, 0, 1])
    end

    @testset "Bridge: without a host" begin
        B = WasmHost.Bridge
        withenv(NOSPOOL...) do
            @test !B.available()
            @test B.send(Dict("x" => 1)) == false
            @test_throws B.BridgeError B.recv()
        end
        mktempdir() do dir
            withenv("WASMHOST_SPOOL" => dir) do
                # (a spool directory, no adapter: nothing answers)
                @test B.send((x = 1,)) == false
                @test_throws B.BridgeError B.recv()
                @test isempty(readdir(dir))
            end
        end
        # the host's answer to a receive: the handle or errno, and (EPIPE) the page's reason
        mktempdir() do dir
            base = joinpath(dir, "1")
            write(base * ".rcv", "-64\npage gone")
            @test B.start_recv(base, true) == (Int32(-64), "page gone")
            write(base * ".rcv", "12")
            @test B.start_recv(base, true) == (Int32(12), "")
            write(base * ".rcv", "x")
            @test B.start_recv(base, true) === nothing
        end
        # (JSON escapes: a lone high surrogate is U+FFFD, the escape after it its own character; a truncated header)
        p = B.Parser(Vector{UInt8}(codeunits("\"\\ud800\\u0041\"")), 1, 0)
        @test B.parse_string!(p) == "\ufffdA"
        @test_throws B.BridgeError B.decode(UInt8[1, 0, 0, 0, UInt8('[')])
        @test_throws B.BridgeError B.decode(UInt8[1, 0, 0, 0, UInt8('{')])
        # an answer to an ask nobody made, a second answer: dropped
        ch = Channel{Any}(1)
        B.PENDING[99] = ch
        B.deliver_reply!(Dict{String,Any}("bridge_reply" => 99, "value" => 1))
        B.deliver_reply!(Dict{String,Any}("bridge_reply" => 99, "value" => 2))
        B.deliver_reply!(Dict{String,Any}("bridge_reply" => 98, "value" => 3))
        @test take!(ch) == 1 && !isready(ch)
        B.deliver_reply!(Dict{String,Any}("bridge_reply" => 99, "error" => "no such op"))
        r = take!(ch)
        @test r isa B.Failed && r.err isa B.AskError && r.err.msg == "no such op"
        delete!(B.PENDING, 99)
    end

    @testset "JavaScript: bridge codec round trip" begin
        if node === nothing
            @test_skip "$runtime not found"
        else
            B = WasmHost.Bridge
            v = (s = "é\n\"q\"", d = Dict("x" => 1), b = [true, false], t = (1, "x"), f = Float32[1, 2.5], i = Int32[-1, 7],
                 n = nothing, nested = Dict{String,Any}("v" => Any[1.5, "s"]))
            script = """
            import fs from 'node:fs';
            import { encodeFrame, decodeFrame } from $(js("common", "bridge.mjs"));
            const v = decodeFrame(fs.readFileSync(process.argv[1]));
            const ok = v.s === 'é\\n"q"' && v.d.x === 1 && v.b[0] === true && v.b[1] === false && v.t[0] === 1 && v.t[1] === 'x' &&
                       v.f instanceof Float32Array && v.f[1] === 2.5 && v.i instanceof Int32Array && v.i[0] === -1 && v.n === null &&
                       v.nested.v[0] === 1.5;
            v.back = new Float64Array([0.25, -3]);
            v.big = 2n ** 40n;
            fs.writeFileSync(process.argv[2], encodeFrame(v));
            process.stdout.write(ok ? 'decoded' : 'WRONG ' + JSON.stringify(v));
            """
            mktempdir() do dir
                a, b = joinpath(dir, "a"), joinpath(dir, "b")
                write(a, B.encode(v))
                @test read(`$node --input-type=module -e $script $a $b`, String) == "decoded"
                w = B.decode(read(b))
                @test w["s"] == v.s && w["d"] == Dict{String,Any}("x" => 1) && w["t"] == Any[1, "x"]
                @test w["f"] == Float32[1, 2.5] && w["f"] isa Vector{Float32} && w["i"] == Int32[-1, 7]
                @test w["back"] == [0.25, -3.0] && w["back"] isa Vector{Float64} && w["big"] == 2^40
            end
        end
    end

    # js/common/bridge.mjs on its own (test/bridge_unit.mjs): a write that throws (the module's receive is not
    # stranded, the frames stay queued), the queue's capacity and overflow, bounded chunks, closing from either side,
    # the answers of asks, the adapters' files
    @testset "JavaScript: bridge queue, failures, close" begin
        if node === nothing
            @test_skip "$runtime not found"
        else
            out = split(chomp(read(`$node $(joinpath(@__DIR__, "bridge_unit.mjs"))`, String)), '\n')
            @test length(out) >= 40
            for l in out
                @test startswith(l, "ok ")
            end
        end
    end
end
