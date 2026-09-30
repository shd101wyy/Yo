# An aborted task releases a local it moved away before its await

**Severity:** S1 — use-after-free: aborting a task released a value the task had already handed to a new owner

**Status: FIXED (2026-09-29).** Found 2026-09-29 while probing phase 6 of `plans/ASYNC_STATE_MACHINE_GENERATION.md` on the phase-5 branch (#1002). The v0.2.45 seed is not affected: its segment lowering kept this local a C local, since nothing reads it after the await.

## Symptom

`issues/repros/an-aborted-task-releases-a-local-it-moved-before-its-await.yo`: a task moves a `ref` value into an `own(...)` parameter (`_consume(t)`, which stores it in a list), then awaits a timer. The caller aborts the task while it is suspended, and later clears the list.

```
tcache_thread_shutdown(): unaligned tcache chunk detected
```

Valgrind: an invalid read in `__yo_decr_rc` from `<task>_state_dispose_locals`, on a block that the list's clear had already freed.

## Root cause

Under the single-pass lowering every local lives in a state-machine slot. Moving `t` out, which the evaluator records as the variable's `consumed_at_token`, read the slot but left it holding the pointer. The abort dispose drops every non-null slot, so it released the moved value a second time.

## Fix

A read of a state-machine field that is the variable's consuming read takes the value into a C temp and zeroes the slot first (`_sm_consuming_read`, `src/codegen/exprs/atom.yo`). The slot then owns nothing, whichever path the task leaves by. Regression test: `tests/async/sm_ownership.test.yo` "an aborted task does not release a local it moved before its await".
