# An argument's dup temp in an `io.async` body is dropped through an unassigned slot

**Severity:** S2. Each call inside an `io.async` body whose argument is dup'd, such as a container read passed to an owning parameter, leaks one reference.

**Status: FIXED (2026-09-30).** This was a regression of #1018's single-pass lowering; the v0.2.46 seed was clean. It was found by re-verifying `issues/fixed/an-escaped-task-leaks-references-to-values-it-bound.md`, which it turned out to be.

## Symptom

```rust
io.async(e => {
  x := e.io.await(make(keep(usize(0)), e.io), e);
  x
})
```

After the task, `rc(keep(usize(0)))` was 3 where it should be 2, and valgrind reported `12 bytes definitely lost`.

## Cause

`generate_deferred_dup_expressions` (`src/codegen/exprs/drop_dup.yo`) declares a synthesized dup's result temp as a C local:

```c
T* _tmp = __yo_incr_rc(keep(0));
```

The temp's scope-end drop resolves the same name through the state-machine map to its task slot, `__yo_decr_rc(sm->var__tmp…)`. That slot is never written, so the drop decrements NULL.

## Fix

A dup result temp with a task slot is stored into it right after its declaration (`sm_slot_of`), which is how the other call temps are handled (`_store_temp_var_to_state_machine_if_needed`).

Test in `tests/async/sm_ownership.test.yo`: "an argument read out of a container inside a task is released".
