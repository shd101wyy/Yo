# A hoisted condition/scrutinee await combined with another await in an arm or loop body is lowered as plain code

**Severity:** S1 — a hoisted condition await plus an arm/body await lowers as plain code — reads an uninitialized temp (garbage output) or emits invalid C

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit's control-flow shape sweep (`plans/ASYNC_STATE_MACHINE_GENERATION.md` §8). Confirmed with a tree build of develop `af62bdb28` and the v0.2.45 seed, with the inner future both suspending and completing synchronously, at `-O0` and `-O2`. `yo check` is green for every shape here. Expected values come from the same program written synchronously.

## Symptom

- `r := match(await, 3 => 30, 1 => await, _ => 0)`: the awaiting arm emits
  nothing and reads an uninitialized temp. Expected `0,11,33`, got
  `0,<garbage>,33` (`issues/repros/async-shape-b5a-bound-match-await-scrutinee-and-await-arm-garbage.yo`).
  The same happens as the body's tail value.
- Statement form `match(await, 3 => { x = await; }, …)`: clang reports
  `sm->var_x = ;` (`issues/repros/async-shape-b5b-stmt-match-await-scrutinee-and-await-arm-c-error.yo`).
- `if(await_bool, { x = await; }, …)` and the bound `cond` form: clang
  reports `no member named 'cond_branch_1'`
  (`issues/repros/async-shape-b5c-if-await-condition-and-await-arm-c-error.yo`). This is the same
  symptom as `issues/fixed/async-postwhile-multiple-await-ifs.md`, with a
  different trigger.
- `while(await_bool, { t := await; … })`: clang reports `sm->var_t = ;`
  (`issues/repros/async-shape-b5d-while-await-condition-and-await-body-c-error.yo`), including
  inside a nested while.

`docs/en-US/ASYNC_AWAIT.md` ("Where `await` may appear") lists these
condition forms as supported and does not exclude a second await in the
arm or body.

## Root cause

`hoist_non_splittable_awaits` (`src/codegen/async/state_code_gen.yo`) moves
the whole enclosing statement into the next segment. There it is generated
as an ordinary expression and never split again at the arm's await. For
`while`, the condition-await layout in `generate_while_with_await` returns
early, and `_emit_while_condition_await_resume`
(`src/codegen/async/state_machine.yo`) emits the body without splitting it.

## Fix

Plan phase 4–5 (normalisation puts the condition await in statement
position ahead of an ordinary branch). Regression: all four repros.

## Fix (2026-09-29, async state-machine plan phase 5)

The segment lowering this shape broke is deleted. An `io.async` body is now
emitted once, by the ordinary expression generators, into its resume
function: each await suspends where it is written and resumes at its own
label, and every local, pattern binding and await result lives in the task
(`plans/ASYNC_STATE_MACHINE_GENERATION.md` phase 5).

Regression tests (each fails on the v0.2.45 seed): `tests/async_await.test.yo` "a bound match with an awaited scrutinee and an awaiting arm"; `tests/async_await.test.yo` "a statement match with an awaited scrutinee and an awaiting arm"; `tests/async_await.test.yo` "an if with an awaited condition and an awaiting branch"; `tests/async_await.test.yo` "a while with an awaited condition and an awaiting body".
