# An arm with two sequential awaits runs the enclosing code before its second await (and twice inside a loop)

**Status: OPEN.** Found 2026-09-28 by the async state-machine audit's control-flow shape sweep (`plans/ASYNC_STATE_MACHINE_GENERATION.md` §8). Confirmed with a tree build of develop `af62bdb28` and the v0.2.45 seed, with the inner future both suspending and completing synchronously, at `-O0` and `-O2`. `yo check` is green for every shape here. Expected values come from the same program written synchronously.

## Symptom

- Nested if, `issues/repros/async-shape-b3a-nested-if-arm-two-awaits-outer-remaining-runs-early.yo`:
  `if(n>0,{ if(n>1,{ b := await; x = await; }); x = (x+100); })`.
  Expected `105`, got `5`: the `+100` runs before the second await, which
  then overwrites `x`.
- In a loop, `issues/repros/async-shape-b3b-loop-if-arm-two-awaits-body-remaining-runs-twice.yo`:
  the loop body's remaining statements run twice per iteration (`i++`
  twice). Expected `0,1,33`, got `0,2,24`.

This may be the minimized form of the unminimized
`issues/async-await-nested-if-lost-continuation.md`.

## Root cause

In state N+1 the arm stores its second future.
`_emit_nested_branch_continuation` and `_emit_while_continuation`
(`src/codegen/async/state_machine.yo`) then emit the ENCLOSING arm's or loop
body's remaining code right after the arm switch, even when the arm's own
remaining code chained a new await (`_chain_additional_remaining`). The
enclosing code is emitted again after the second await.

## Fix

Plan phase 5. Regression: both repros in the shape corpus.
