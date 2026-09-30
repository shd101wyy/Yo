# A bare block in an `io.async` body keeps its locals until the task ends

**Severity:** S3 — a block's values are released late (at task completion), and a `Dispose` runs later than the same code run synchronously

**Status: FIXED (2026-09-29).** Found while testing slot sharing for phase 6 of `plans/ASYNC_STATE_MACHINE_GENERATION.md`. The v0.2.45 seed has it too.

## Symptom

```rust
io.async((e : Io) => {
  {
    a := Thing(n : i32(1));
    e.await(yield(e), e);
    use(a);
  };
  // `a` should be disposed here, as it is in a sync function
  e.await(sleep(u64(50)), e);
  ...
})
```

A `{ … }` block that contains an await did not release its locals at its end. They lived until the task completed, or until an aborted task's state machine was freed. The same code in a sync function disposes `a` at the block's end.

## Root cause

`flatten_nested_await_blocks` (`src/codegen/exprs/async.yo`) spliced every nested bare block that contains an await into the statement list that holds it, and moved the block's scope-end drops onto the enclosing block. The segment lowering needed that: it split statement lists at their awaits and had no class for a statement that is itself a block (`issues/fixed/async-nested-bare-block-in-loop-arm-dropped.md`). Phase 5 deleted that lowering, but not the splice.

## Fix

The splice is deleted. The single-pass lowering emits a nested block like any other code, as a C block whose resume labels a `goto` may enter. Regression test: `tests/async/sm_ownership.test.yo` "a bare block's heap local is released at the block's end, not the task's". It fails on the seed, where the task sees `disposed = 0` after the block.
