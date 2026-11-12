# The end-to-end program of page messages (WasmHost.Page): messages of several sizes and UTF-8
# strings sent to the host, and the host's messages received and sent back. The host's side and
# the checks are in prun.mjs (in Wasm) and pnative.jl (natively); the data are made by the same
# formulas on both sides.
module PageProg
using WasmHost
const Page = WasmHost.Page

say(xs...) = (println(Core.stdout, xs...); nothing)

# the messages' sizes: empty, small, a word, 1 KiB, 64 KiB, and one past a chunk of Staging (1 MiB,
# as receive copies in)
const SIZES = (0, 1, 7, 1024, 65536, 1048577)
# the strings' lengths in characters (the last one is more than 1 MiB of UTF-8)
const LENGTHS = (0, 1, 9, 1000, 500000)
# code points of 1, 2, 2, 3 and 4 bytes in UTF-8
const CODEPOINTS = (0x61, 0xe9, 0x3b1, 0x20ac, 0x1f600)

"`n` bytes: byte i is (7i + seed) mod 256."
pattern(n::Int, seed::Int) = UInt8[(7 * i + seed) % UInt8 for i in 1:n]
"`n` characters: character i is CODEPOINTS[(i + seed) mod 5 + 1] (2.4 bytes each on average)."
text(n::Int, seed::Int) = String(Char[Char(CODEPOINTS[(i + seed) % 5 + 1]) for i in 1:n])

"FNV-1a of the bytes (64 bits)."
function fnv(b::Vector{UInt8})::UInt64
    h = 0xcbf29ce484222325
    for x in b
        h = (h ⊻ x) * 0x00000100000001b3
    end
    return h
end

# the messages the program sends: patterns (seed k), then texts (seed k)
function send_all()
    for (k, n) in enumerate(SIZES)
        Page.send(pattern(n, k))
        say("S", k, " ", n)
    end
    for (k, n) in enumerate(LENGTHS)
        s = text(n, k)
        Page.send(s)
        say("U", k, " ", n, " ", sizeof(s))
    end
    return nothing
end

# each message the host posted: its length and hash, and the message sent back
echo(m::Vector{UInt8}) = (say("R ", length(m), " ", string(fnv(m); base = 16)); Page.send(m))

function main()::Int32
    send_all()
    n = Page.poll(echo)
    say("R count ", n)
    # (nothing more: a second poll finds none)
    say("R again ", Page.receive() === nothing)
    return Int32(0)
end

# without receiving: for `host = :js`, where only sending is possible
main_send()::Int32 = (send_all(); Int32(0))

const BENCH = UInt8[]
"Make the message of `n` bytes the benchmark sends."
bench_message(n::Int32) = (resize!(BENCH, n); for i in 1:n; BENCH[i] = (7 * i + 3) % UInt8; end; n)
"Send it once."
bench_send() = (Page.send(BENCH); Int32(0))

end # module
