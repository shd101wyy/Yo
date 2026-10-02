# A JoinHandle await used inline in a task never releases its result

**Severity:** S2. `match(h.await(e), .Some(t) => …, .None => …)` inside a task leaks the awaited result each time it runs.

**Status: FIXED (2026-10-01).** It was found while fixing `issues/fixed/a-spawned-futures-temp-across-an-await-never-releases-its-creation-reference.md`: with that leak fixed, the same test still leaked the spawned task's `Thing`.

## Symptom

```rust
io.async((e : Io) => {
  h := e.spawn(work(e), e);
  e.await(yield(e), e);
  match(h.await(e), .Some(t) => t.n, .None => i32(-1))
})
```

`Thing`'s `Dispose` never ran for the result.

## Cause

`generate_join_handle_await` (`src/codegen/exprs/await.yo`) puts the dup'd result into a C local. The result's temp lives across the task's layout boundary, so the liveness pass gives it a task slot, and its scope-end drop (the match scrutinee's) resolves to that slot. Nothing ever assigned the slot, so the drop released zero. This is the same Rule 1 shape as the dup temps in `issues/fixed/an-argument-dup-temp-in-an-io-async-body-is-dropped-through-an-unassigned-slot.md`.

## Fix

Inside a state machine, the result is stored into its temp's slot as well (`sm_slot_of`), so the drop releases the value the await produced.

Test in `tests/async/sm_ownership.test.yo`: "a spawned future's temp that crosses an await is released". It counts the result's `Dispose`.
