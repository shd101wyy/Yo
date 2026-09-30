# Reassigning an outer heap local inside an `if` arm in a loop body's post-await code leaks the old value

**Severity:** S1 — the deferred drop of a heap local reassigned in an arm after a loop await is lost — memory grows without bound as the loop runs

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit's control-flow shape sweep (`plans/ASYNC_STATE_MACHINE_GENERATION.md` §8). Confirmed with a tree build of develop `af62bdb28` and the v0.2.45 seed, with the inner future both suspending and completing synchronously, at `-O0` and `-O2`. `yo check` is green for every shape here. Expected values come from the same program written synchronously.

## Symptom

`while(.., { await; if(c, { last = String.from("hit"); … }) })`:
LeakSanitizer reports the saved old value, never dropped
(`issues/repros/async-shape-l2-reassign-heap-local-in-arm-after-loop-await-leaks.yo`). The same
arm without the loop is clean.

## Root cause

The C saves the old value into an `sm->` slot for a deferred drop ("Save
old value for deferred drop"), but the loop-body remaining code emitted by
`_emit_while_continuation` (`src/codegen/async/state_machine.yo`) loses
the arm's deferred drops.

## Fix

Plan phase 5 (drops follow the ordinary scope structure). Regression: the
repro under LSan.

## Fix (2026-09-29, async state-machine plan phase 5)

The assignment saves the old value into the temp's own state-machine slot
(`sm->var_<temp> = sm->var_last;`) but did not record the temp as declared.
The arm's scope-end drop skips a minted temp that was never declared (the
undeclared-temp gate in `begin.yo`/`drop_dup.yo`), so the old value was never
released. The slot is the temp's storage, so the assignment now records it
as declared (`src/codegen/exprs/assignment.yo`). Valgrind is clean on the
reproducer. Regression test: `tests/async/sm_ownership.test.yo` "a heap local
reassigned in an arm after a loop await releases the old value" (a `Dispose`
counter; it reads 1 instead of 2 on the v0.2.45 seed).
