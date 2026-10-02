# A `break` or `continue` in an `io.async` loop never releases its slot locals

**Severity:** S2. Every iteration left through `break` or `continue` in a loop that awaits leaks the heap locals of that iteration.

**Status: FIXED (2026-09-30).** This was a regression of #1018's single-pass lowering. The v0.2.46 seed was clean.

## Symptom

```rust
io.async((io : Io) => {
  while(runtime(true), {
    temp := Box(i32)(counter.*);
    io.await(yield(io), io);
    counter.* = (temp.* + 1);
    cond((counter.* >= i32(3)) => { break; }, true => ());
  });
})
```

Valgrind reported `12 bytes in 1 blocks are definitely lost`. With leak verdicts on, 8 tests in `tests/async_await.test.yo` failed: the break/continue drop tests 27–31 and their neighbours.

## Cause

`_emit_loop_body_drops_before_exit` (`src/codegen/exprs/atom.yo`) keeps a loop-body drop only when the target's C variable is declared in an open C block (`declared_scopes`). Under Rule 1, a local that lives across an await is never a C variable. Its binding writes `sm->var_…`. So every such drop was skipped on a `break` or `continue`, and only the fall-through end of the body released the local.

## Fix

A drop target with a task slot (`sm_slot_of`, `src/codegen/async/state_machine_naming.yo`) counts as present. The slot always exists and is zero while it owns nothing, so only the liveness test still applies.

Tests in `tests/async/sm_ownership.test.yo`:
- "a break out of an awaiting while releases the iteration's slot local";
- "a continue in an awaiting while releases the iteration's slot local".
