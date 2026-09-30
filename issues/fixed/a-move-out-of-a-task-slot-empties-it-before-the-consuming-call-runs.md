# A move out of a task slot empties it before the consuming call runs

**Severity:** S1. A task that moves a slot local into a call and reads it again in a later argument of the same call dereferences NULL. v0.2.47's own `yo unsafe-report`, `yo public-safe-report` and `yo update --latest` segfault (rc=139), because the compiler's `generate_unsafe_report` has that shape.

**Status: FIXED (2026-10-01).** This is a regression of #1002's consuming read (`issues/fixed/an-aborted-task-releases-a-local-it-moved-before-its-await.md`), shipped in #1018 and v0.2.47. Develop's "Self-hosted `test` subcommand" job went red once `SEED_VERSION` became v0.2.47: run 36764200992, with three CLI cases at rc=139. yo-bd diagnosed it.

## Symptom

```rust
io.async((e : Io) => {
  xs := ArrayList(i32).new();
  xs.push(i32(1));
  e.await(yield(e), e);
  Report(items : xs, n : xs.len())
})
```

rc=139. The emitted C was:

```c
T __yo_moved0 = sm->var_xs; memset(&sm->var_xs, 0, ...);   // arg 1: the move, taken at the read
... Report(__yo_moved0, len(sm->var_xs)) ...               // arg 2: reads the emptied slot
```

## Cause

`_sm_consuming_read` (`src/codegen/exprs/atom.yo`) took the value into a C temp and zeroed the slot at the moving read. The move only happens when the consuming call runs, after all of its arguments are evaluated. So a later argument that reads the same local, which the evaluator allows, read the empty slot.

The same placement had a second fault. An await in a later argument (`Report(items : xs, n : e.await(f, e))`) suspends before the call's line runs, and the C temp does not survive the suspension. Meanwhile the zeroed slot no longer owned the value, so an abort during that await leaked it.

## Fix

The consuming read renders the slot itself, plus a unique `/*yo_mv:…*/` marker, and defers the zeroing (`Emitter.defer_move_zero`, `src/emitter.yo`). The emitter empties the slot right after the line that carries the marker, which is the line where the consuming call, binding or store actually runs.

The lowering emits every suspension inside an expression ahead of that expression's line, so until then the slot still owns the value, and an abort in a later argument's await releases it once. The clearing of a pattern binding's source (`issues/fixed/async-abort-dispose-double-drops-moved-enum-payload.md`) rides along in the same deferred statements.

Test in `tests/async/sm_ownership.test.yo`: "a later argument of the consuming call still reads a moved slot local". It also covers an await in a later argument and counts each item's `Dispose`. The three CLI cases pass on a stage 2 built from this tree.
