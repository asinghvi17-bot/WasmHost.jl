# Native tests of the protocols and of the JavaScript adapter's parts (no WasmCodegen needed), the latter in Node or
# in Bun (WASM_RUNTIME).
# The end-to-end checks, which compile programs with WasmCodegen and run them in Node, are in
# test/e2e/e2e.jl.
using Test, WasmHost
using WasmHost: split_lines, spool_dir
using WasmHost.Downloads: request_text, parse_result, Result
using WasmHost.Decompress: DecompressError, decompress, parse_answer
using Base.BinaryPlatforms: HostPlatform, triplet, arch, os, libc

const JS = joinpath(dirname(@__DIR__), "js")
js(path...) = repr("file://" * joinpath(JS, path...))
# the JavaScript runtime of the adapter's tests: WASM_RUNTIME=node (the default; NODE) or bun (BUN)
const runtime = get(ENV, "WASM_RUNTIME", "node")
runtime in ("node", "bun") || error("WASM_RUNTIME must be node or bun, not $(repr(runtime))")
const node = something(get(ENV, uppercase(runtime), nothing), Sys.which(runtime), Some(nothing))
const NOSPOOL = ("WASMHOST_SPOOL" => nothing, "WASM_FETCH_SPOOL" => nothing)

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

    @testset "Page: natively" begin
        P = WasmHost.Page
        empty!(P.native_outbox()); empty!(P.native_inbox())
        v = UInt8[1, 2, 3]
        @test P.send(v) === nothing
        v[1] = 0x09   # (a copy was kept)
        P.send("αβ")
        P.send(UInt8[])
        @test P.native_outbox() == [UInt8[1, 2, 3], Vector{UInt8}(codeunits("αβ")), UInt8[]]
        @test P.receive() === nothing
        push!(P.native_inbox(), UInt8[7], UInt8[], UInt8[8, 9])
        @test P.receive() == UInt8[7]
        seen = Vector{UInt8}[]
        @test P.poll(m -> push!(seen, m)) == 2
        @test seen == [UInt8[], UInt8[8, 9]] && P.receive() === nothing && P.poll(identity) == 0
        empty!(P.native_outbox())
    end

    # the page adapter's imports as a module calls them, on a memory of its own: messages sent,
    # posted messages read in chunks, and the errors
    @testset "JavaScript: page adapter" begin
        if node === nothing
            @test_skip "$runtime not found"
        else
            script = """
            import { makePage, LIBRARY } from $(js("common", "page.mjs"));
            const memory = new WebAssembly.Memory({ initial: 1 });
            const mem = new Uint8Array(memory.buffer);
            const got = [];
            let views = 0;
            const page = makePage({ onMessage: (b) => { views += b.buffer === memory.buffer; got.push(Array.from(b)); } });
            page.bindMemory(memory);
            const { send, pending, read, pop } = page.imports[LIBRARY];
            mem.set([1, 2, 3, 4, 5], 100);
            send(100, 3);                          // a view of the memory
            send(100, 5);
            send(0, 0);                            // empty
            page.post('αβ'); page.post(new Uint8Array([9, 8, 7, 6])); page.post(new ArrayBuffer(0));
            const out = [pending()];
            read(200, 0, 2); read(202, 2, 2); pop();
            out.push(Array.from(mem.subarray(200, 204)), pending());
            read(300, 1, 3); pop();
            out.push(Array.from(mem.subarray(300, 303)), pending()); pop();
            out.push(pending(), page.queued());
            const errs = [];
            page.post(new Uint8Array(2));
            for (const f of [() => read(0, 1, 2), () => pop(), () => read(0, 0, 1), () => pop(), () => page.post(42)]) { try { f(); errs.push('none'); } catch (e) { errs.push(e.constructor.name); } }
            // (an exception of onMessage goes to onError, not to the module)
            const caught = [];
            const failing = makePage({ memory, onMessage: () => { throw new Error('boom'); }, onError: (e, b) => caught.push([e.message, b.length]) });
            let threw = false;
            try { failing.imports[LIBRARY].send(100, 3); } catch { threw = true; }
            process.stdout.write(JSON.stringify({ got, views, out, errs, stats: page.stats, caught, threw, errors: failing.stats.errors }));
            """
            r = read(`$node --input-type=module -e $script`, String)
            @test occursin("\"got\":[[1,2,3],[1,2,3,4,5],[]]", r)
            @test occursin("\"views\":3", r)   # (each message is a view of the memory)
            @test occursin("\"out\":[4,[206,177,206,178],4,[8,7,6],0,-1,0]", r)
            # (past the end, then fine; then nothing pending; a message of the wrong kind)
            @test occursin("\"errs\":[\"RangeError\",\"none\",\"Error\",\"Error\",\"TypeError\"]", r)
            @test occursin("\"stats\":{\"sent\":3,\"sentBytes\":8,\"received\":4,\"receivedBytes\":10,\"errors\":0}", r)
            @test occursin("\"caught\":[[\"boom\",3]],\"threw\":false,\"errors\":1", r)
        end
    end
end
