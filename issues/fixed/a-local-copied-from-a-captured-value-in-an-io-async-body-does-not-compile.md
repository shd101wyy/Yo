# A local copied from a captured value in an `io.async` body does not compile

**Severity:** S2 — a common shape (a local bound to a value the task captured) was a C compile error; it also blocked `for_await`, which binds its stream that way

**Status: FIXED (2026-09-29).** Found while restoring `for_await` (phase 7 branch of `plans/ASYNC_STATE_MACHINE_GENERATION.md`). The v0.2.45 seed has it too.

## Symptom

`issues/repros/a-local-copied-from-a-captured-value-in-an-io-async-body-does-not-compile.yo`:

```rust
c := Countdown(_n : i32(3));
task := io.async((io : Io) => {
  s := c;                          // s shares c's RC value
  ...
  nx := io.await(s.next(io), io);  // s read after an await
  ...
});
```

```
error: no member named 'var_356721' in 'struct …_state_t_struct'
error: no member named 's' in 'struct __yo_t_…'   (the capture struct)
```

## Root cause

A local that shares its owner's RC value (`is_owning_the_same_rc_value_as`) was never captured by the suspension analysis. Only its owner was, and codegen sent the local's reads and writes to the owner's slot. That works when the owner is a local of the body. Here the owner `c` is a capture, which lives in `sm->__capture.c`:

- the declaration `s := c` stored into `sm->var_<c's id>`, a field that does not exist;
- the reads rendered `sm->__capture.s`, the owner's slot under the local's own name.

## Fix

- The analysis now captures the local too, marked as sharing its owner's value, so the dispose and slot sharing skip it.
- One rule, `sm_storage_id` (`src/codegen/async/state_machine_naming.yo`), decides where the local lives. Both the atom emitter and the declaration store use it:
  - the owner's slot when the owner is a local of the body. The local then gets no field, and its reads keep the owner live;
  - storage of its own otherwise.

Tests:
- `tests/async_await.test.yo`: "a local copied from a captured value, written and read across awaits";
- `tests/async/sm_ownership.test.yo`: "an aborted task does not release a local copied from its capture".
