# A `while` with an await in its step AND in its body is miscompiled

**Severity:** S1 — a while with an await in both its step and its body emits invalid C (`sm->var_t1 = ;`) or segfaults at runtime on valid input

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit's control-flow shape sweep (`plans/ASYNC_STATE_MACHINE_GENERATION.md` §8). Confirmed with a tree build of develop `af62bdb28` and the v0.2.45 seed, with the inner future both suspending and completing synchronously, at `-O0` and `-O2`. `yo check` is green for every shape here. Expected values come from the same program written synchronously.

## Symptom

- `while(i<n, i = await, { t := await; … })`: clang reports
  `sm->var_t1 = ;` (`issues/repros/async-shape-b6a-while-await-step-and-await-body-c-error.yo`).
- A bare `await;` statement in the body instead gives SIGSEGV
  (`issues/repros/async-shape-b6b-while-await-step-and-bare-await-body-segv.yo`).

## Root cause

When the step awaits, `generate_while_with_await`
(`src/codegen/async/state_code_gen.yo`) emits the body with
`generate_whole_while_body`, which is documented as await-free.

## Fix

Plan phase 5. Regression: both repros.

## Fix (2026-09-29, async state-machine plan phase 5)

The segment lowering this shape broke is deleted. An `io.async` body is now
emitted once, by the ordinary expression generators, into its resume
function: each await suspends where it is written and resumes at its own
label, and every local, pattern binding and await result lives in the task
(`plans/ASYNC_STATE_MACHINE_GENERATION.md` phase 5).

Regression tests (each fails on the v0.2.45 seed): `tests/async_await.test.yo` "a while with an awaiting step and a bound await in the body"; `tests/async_await.test.yo` "a while with an awaiting step and a bare await in the body".
