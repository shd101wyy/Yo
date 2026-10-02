# A spawned future's temp that crosses an await never releases its creation reference

**Severity:** S2. `h := io.spawn(work(io), io)` inside a task, followed by an await, leaks the spawned task's whole state machine and its result.

**Status: FIXED (2026-10-01).** This is the long-standing leak behind `tests/async/while_await_in_match_arm.test.yo`, under leak verdicts, on the v0.2.46 seed and on develop `29bf728b4`.

## Symptom

```rust
io.async((e : Io) => {
  h := e.spawn(work(e), e);
  e.await(sleep(…), e);
  …
})
```

Valgrind: `88 bytes definitely lost`, from `__yo_sm_take` in the `work` task's constructor.

## Cause

The future temp `work(e)` is a C local. Its escape-path drop, its scope-end drop and the abort dispose all read its task slot `sm->var__…_temp…`, which the liveness layout gives it because it lives across an await it is not the operand of. `_store_temp_var_to_state_machine_if_needed` (`src/codegen/exprs/other_fn_call.yo`) returned early for every Future-typed temp, a leftover from the old `await_future_X` fields. So the slot stayed zero while the temp owned +1, and every drop was a no-op. That broke the zero invariant.

## Fix

Only a future temp that an `io.await` consumes stays out of its slot, because its ownership moves to `__yo_await_slot`. `compute_cross_boundary_variables` records those temps (`note_await_consumed_temp`, `src/codegen/async/state_machine_naming.yo`), and the store skips only them. Every other future temp is an owner like any temp: its slot is non-zero from creation, and its drops release it.

Test in `tests/async/sm_ownership.test.yo`: "a spawned future's temp that crosses an await is released". The two `race` tests in `tests/async/while_await_in_match_arm.test.yo` now abort their losing tasks, and are leak-clean. The losers still pending at thread exit are `issues/tasks-still-pending-or-queued-at-thread-exit-are-never-released.md`.
