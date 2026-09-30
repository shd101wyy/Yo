# An escape inside a reassignment's await releases the old value twice

**Severity:** S1 — heap use-after-free: a task that escapes while reassigning a heap local from an await released the local's old value twice

**Status: FIXED (2026-09-30).** Found by CI on #1002, the phase 5 PR of `plans/ASYNC_STATE_MACHINE_GENERATION.md`: `tests/http/http.test.yo` "fetch still refuses an unsupported scheme" failed under ASan on every platform. The v0.2.46 seed passes it: this was a regression of the single-pass lowering.

## Symptom

`std/http/client.yo`'s `fetch` reassigns `result` from an await whose callee throws `UnsupportedScheme`:

```
==355914==ERROR: AddressSanitizer: heap-use-after-free
    #0 __yo_decr_rc
    #1 <fetch task>_state_dispose_locals
    #2 <fetch task>_state_dispose
  freed by: __yo_decr_rc ← <fetch task>_state_dispose_locals   (the same call)
```

Minimal shape, now the test in `tests/async/sm_protocol.test.yo`:

```rust
(t : Thing) = Thing(n : i32(1));
t = e.io.await(_sm_throws_thing(e.io), e);   // the child throws; the task escapes here
```

## Root cause

A reassignment saves the old value in a temp and drops it after the store. The save was emitted BEFORE the right-hand side. Under the single-pass lowering the temp is live across the await, so it lives in a task slot. When the task escaped inside the await, `t`'s slot and the save's slot held the same pointer, and the abort dispose, which drops every non-null slot, released it twice.

The inline escape path already knew the old value belongs to the local until the store (`current_assignment_save_temp`); the dispose sweep could not.

## Fix

In a state machine, the save is written after the right-hand side, just before the store (`sm_save_line`, `src/codegen/exprs/assignment.yo`). The window where two slots own one value no longer contains a suspension. A right-hand side that moves the old value out zeroes its slot (`_sm_consuming_read`), so the late save reads NULL.

Regression test: `tests/async/sm_protocol.test.yo` "an escape inside a reassignment's await releases the old value once". It fails on the branch before the fix.
