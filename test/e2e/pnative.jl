# julia --project=ENV pnative.jl: pprog.jl natively, the host's messages in `Page.native_inbox()`:
# its output, and whether the messages it sent are the ones prun.mjs checks for.
include(joinpath(@__DIR__, "pprog.jl"))
using .PageProg: PageProg, Page, SIZES, LENGTHS, pattern, text

# what the host posts: patterns (seed 100 + k), then texts (seed 10 + k)
posted = vcat([pattern(n, 100 + k) for (k, n) in enumerate(SIZES)],
              [Vector{UInt8}(codeunits(text(n, 10 + k))) for (k, n) in enumerate(LENGTHS)])
append!(Page.native_inbox(), copy.(posted))
PageProg.main()
sent = Page.native_outbox()
expected = vcat([pattern(n, k) for (k, n) in enumerate(SIZES)],
                [Vector{UInt8}(codeunits(text(n, k))) for (k, n) in enumerate(LENGTHS)], posted)
println("page check: ", sent == expected, " (", length(sent), " messages)")
