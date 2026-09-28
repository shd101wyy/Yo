# A primitive-value `match` arm holding a while-with-await runs its post-loop code every iteration

**Status: OPEN.** Found 2026-09-28 by the async state-machine audit's control-flow shape sweep (`plans/ASYNC_STATE_MACHINE_GENERATION.md` §8). Confirmed with a tree build of develop `af62bdb28` and the v0.2.45 seed, with the inner future both suspending and completing synchronously, at `-O0` and `-O2`. `yo check` is green for every shape here. Expected values come from the same program written synchronously.

## Symptom

`match(n, 0 => …, _ => { while(…await…); acc = acc + 100; })`: expected
`-1,100,103`, got `-1,100,303`
(`issues/repros/async-shape-b7-prim-match-arm-post-while-code-every-iteration.yo`). This is a new
shape of the fixed
`issues/fixed/a-while-loop-inside-a-match-arm-runs-its-trailing-code-every-iteration.md`.

## Root cause

`generate_primitive_match_with_await` (`src/codegen/async/state_code_gen.yo`)
passes `emission.remaining` through without the
`_attach_cond_branch_post_while` that the enum-match path
(`_emit_match_case_await_or_value`) received in the earlier fix. The two
match paths have drifted apart.

## Fix

Plan phase 5 (one path for all branch constructs). Regression: the repro.
