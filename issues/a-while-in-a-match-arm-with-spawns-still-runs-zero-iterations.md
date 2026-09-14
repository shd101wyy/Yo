# A `while` in a match arm whose condition reads spawned handles still runs zero iterations

**Found**: 2026-09-14, while fixing
`issues/fixed/a-while-loop-inside-a-match-arm-runs-its-trailing-code-every-iteration.md`.
**Status**: OPEN — a SECOND defect in the same family, NOT fixed by that change.

## Symptom

`issues/repros/while-in-match-arm-loses-its-loop.yo` still prints:

```
turns=0
BUG: the while condition was false at entry while both handles were unfinished
```

The loop body never runs, and the statement after the loop does not run either
— where before the trailing-code fix it ran once, on iteration zero.

## What distinguishes it from the fixed defect

Both live in a match arm. The fixed one needed only `while` + a trailing
statement. This one additionally has **two `io.spawn` calls in the same arm,
before the loop**:

```rust
.Limit(secs) => {
  h  := e.io.spawn(<a 30 ms task>, e.io);
  dh := e.io.spawn(sleep(Duration.from_secs(secs), e.io), e.io);
  while(runtime(!h.is_finished() && !dh.is_finished()), { e.io.await(yield(e.io), e.io); turns = (turns + i64(1)); });
  println(`after loop: ...`);
}
```

Measured while narrowing, all on the FIXED compiler:

| shape | result |
| --- | --- |
| arm + while + trailing statement | correct (this is what was fixed) |
| arm + ONE spawn + while + trailing `_u := h.is_finished();` | correct |
| arm + TWO spawns + while + trailing `println` | **zero iterations** |
| condition `!h.is_finished() && !dh.is_finished()` | zero iterations |
| condition `turns < i64(5)` (no method calls) | zero iterations |

So the condition's shape is NOT the trigger — the same counter condition works
without the spawns. Something about the spawns in the arm is.

## Why it is filed rather than fixed

The production case it came from — `std/http`'s `_fetch_deadline`, which has
exactly two spawns — now works, and `tests/http/http.test.yo` is 51/51. So this
is not what #556 needed, and bundling a second speculative codegen change into
that fix would make both harder to review and to revert.

It is real, it is narrow, and it has a standalone reproducer that needs no
network. It should be fixed on its own.

## Where to start

The fixed defect was `_emit_match_case_await_or_value` not mirroring
`generate_cond_with_await`'s `has_while` split. The natural suspicion is that
`has_while` (a lookup of `context.async_while_loop_info` at
`await_point.base.index`) does not see the loop in this shape — the spawns
introduce await points of their own, so the index the arm is keyed under may not
be the one the while registered. Check that before anything else: print the map
keys and the arm's `await_point.base.index` for both shapes and compare.
