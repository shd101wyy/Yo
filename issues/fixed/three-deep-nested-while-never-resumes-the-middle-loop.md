# Three nested `while` loops with an await in the innermost: the middle loop never resumes

**Severity:** S1 — with three nested loops the middle loop's continuation registers to the outermost — it iterates once and the program silently computes wrong results (9 instead of 27)

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit's control-flow shape sweep (`plans/ASYNC_STATE_MACHINE_GENERATION.md` §8). Confirmed with a tree build of develop `af62bdb28` and the v0.2.45 seed, with the inner future both suspending and completing synchronously, at `-O0` and `-O2`. `yo check` is green for every shape here. Expected values come from the same program written synchronously.

## Symptom

`issues/repros/async-shape-b2-three-deep-while-middle-loop-skipped.yo`: expected `0,1,27`, got
`0,1,9`. After the inner loop finishes, the resume jumps straight to the
OUTERMOST loop's continue. The middle loop's continuation and its remaining
statements never run, so it iterates once. The emitted C also stacks
`while_loop_0_end: while_loop_2_end: while_loop_1_end:` on one spot. Two
levels work.

## Root cause

`WhileLoopInfo.outer_while_loop` (`src/codegen/functions/context.yo`) holds
ONE enclosing level. When the inner loop's continuation is registered in
`src/codegen/async/state_machine.yo` (`existing_next.outer_while_loop.is_none()`),
the first registration wins, and that is the outermost loop.
`_emit_outer_while_continuation` then emits only that one level.

## Fix

Plan phase 5 (the single-pass lowering keeps C loops structured across
suspensions, so no loop needs a hand-emitted continuation). The regression
test is the repro in the phase-0 shape corpus.

## Fix (2026-09-29, async state-machine plan phase 5)

The segment lowering this shape broke is deleted. An `io.async` body is now
emitted once, by the ordinary expression generators, into its resume
function: each await suspends where it is written and resumes at its own
label, and every local, pattern binding and await result lives in the task
(`plans/ASYNC_STATE_MACHINE_GENERATION.md` phase 5).

Regression tests (each fails on the v0.2.45 seed): `tests/async_await.test.yo` "a three-deep awaiting while resumes the middle loop".
