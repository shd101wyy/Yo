# Nested `while`-with-`await` emits `goto` to a label that is never defined

**Status: OPEN — LIVE in the current compiler, not just the seed.** Found
2026-08-15 when it broke every seed-driven CI job and blocked the v0.2.5
release.

## Repro

`issues/repros/nested-await-loop-undefined-label.yo` (~40 lines). Shape: a
`while` loop containing an `io.await`, nested inside ANOTHER `while` loop
containing an `io.await`, both inside `match` arms, all inside `io.async`.

```
./yo-cli compile issues/repros/nested-await-loop-undefined-label.yo \
  --skip-c-compiler --emit-c-to /tmp/probe.c     # rc=0, emits happily
clang -std=c11 -w -fsyntax-only /tmp/probe.c
```

```
/tmp/probe.c:13566:14: error: use of undeclared label 'after_while_loop_0'
        goto after_while_loop_0;
             ^
```

## Diagnosis: two label-naming conventions, only one emitted

In the emitted C for the repro:

| label                | defined? | referenced? |
| -------------------- | -------- | ----------- |
| `while_loop_0_end`   | YES      | —           |
| `after_while_loop_0` | **NO**   | YES (goto)  |
| `while_loop_1_end`   | YES      | —           |
| `after_while_loop_1` | YES      | YES         |

The OUTER loop emits its exit label as `while_loop_0_end` while an exit path
jumps to `after_while_loop_0`. The INNER loop gets both names, which is why a
single (non-nested) await-loop has never tripped this — the two conventions
happen to coincide there.

So this is a naming mismatch between the async while-loop lowering and whatever
emits the loop-exit `goto`, and it only diverges for the outer loop of a nested
pair.

## Why it matters more than it looks

**The compiler exits 0.** It emits C it cannot compile, so the failure surfaces
as a C-compiler error with a line number in a 2.2-million-line generated file.
That is a long way from the two Yo `while` loops that caused it.

Both compilers are affected — reproduced on the CURRENT TypeScript compiler,
and the v0.2.4 seed produced the identical error while building `yo-self`
(`yo.c:2256845`), which is what made it release-blocking.

## Encountered as

`yo-self/version_cache.yo`'s `list_cached_versions` grew an outer loop over two
version roots (P3 item 1's installer/cache unification) around an existing loop
over directory entries. Both loops await. Every seed-driven CI job then failed
at stage 1. Worked around at the call site in `1238d7d59` by extracting the
inner loop into its own async function (`_scan_versions_root`) — which is
better code anyway, but the codegen bug is untouched and will catch the next
person who nests two await-loops.

## Localised to four lines (2026-08-15)

All in `src/codegen/async/state-machine.ts`:

| line    | what it does                                         |
| ------- | ---------------------------------------------------- |
| `:2228` | emits the `goto after_while_loop_${whileLoopIndex};` |
| `:1590` | emits `after_while_loop_${whileLoopActiveIndex}:`    |
| `:1981` | emits `after_while_loop_${outerIndex}:`              |
| `:2959` | emits `after_while_loop_${loopIndex}:`               |

The `goto` index comes from
`whileLoopInfoForAwait.whileLoopOriginIndex ?? segment.awaitPoint.index`
(`:2225-2227`). For the OUTER loop of a nested pair that resolves to 0, and
**none of the three emit sites fires for 0** — the inner loop gets its label
from one of them, which is why `after_while_loop_1` exists and
`after_while_loop_0` does not.

So the question for whoever fixes this is narrow: _under what condition should
one of :1590 / :1981 / :2959 fire for the outer loop, and why does the nesting
suppress it?_ Answer that and the fix is small.

**Deliberately not attempted in the session that found it.** This is the async
state-machine emitter — a wrong change here silently miscompiles every async
program, and the differential plus fixpoint take ~2 hours to say so. It wants a
fresh session with the repro in hand, not a tired one.

## Fix direction

Make the loop-exit label name agree. Either emit `after_while_loop_N` alongside
`while_loop_N_end` for every loop, or change the exit `goto` to target
`while_loop_N_end`. The inner loop already emits both, so the simplest correct
change is likely to make the outer path do what the inner one does.

## Verify

The repro must compile end-to-end:

```
./yo-cli compile issues/repros/nested-await-loop-undefined-label.yo -o /tmp/probe && /tmp/probe
```

Expected: `probe=1`. Today it fails at the C compiler.
