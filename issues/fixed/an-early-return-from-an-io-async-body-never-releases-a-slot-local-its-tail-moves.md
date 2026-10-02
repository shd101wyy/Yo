# An early return from an `io.async` body never releases a slot local its tail moves

**Severity:** S2. A `return(…)` from an `io.async` body leaks each heap local that crossed an await and that the body's tail would have moved out. The v0.2.46 seed leaks too.

**Status: FIXED (2026-09-30).** Found by re-verifying `issues/retired/async-tail-match-return-hangs-state-machine.md`.

## Symptom

```rust
io.async((e : Io) => {
  results := String.from("held-across-await");
  e.await(yield(e), e);
  if(early, { return(String.from("early")); });
  results
})
```

Valgrind reported `32 bytes in 1 blocks are definitely lost` on the early path. The emitted C printed `// Drop local variables before early completion` and no drop. The same shape in a plain function is clean.

## Cause

The tail moves `results`, so it has no scope-end drop. The evaluator attaches its drop to each `return` instead, as an early-return-only drop. `generate_early_return_only_deferred_drop_expressions` (`src/codegen/exprs/return.yo`) emits a drop only when the target is in the C scope stack, and a slot local never is (the loop-exit class of `issues/fixed/a-break-or-continue-in-an-io-async-loop-never-releases-its-slot-locals.md`).

## Fix

A target with a task slot counts as present (`sm_slot_of`).

Test in `tests/async/sm_ownership.test.yo`: "an early return releases the slot local the tail would have moved".
