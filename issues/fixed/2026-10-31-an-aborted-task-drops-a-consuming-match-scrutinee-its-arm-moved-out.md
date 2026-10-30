# An aborted task drops a consuming match scrutinee its arm moved out

**Severity:** S1 — a double drop in safe code. Inside an `io.async` body, a consuming `match` on a local held in a task slot (`match(first, .Some(fd) => …)`) moves the payload into the arm's binding. When that arm suspends and the task is then aborted (a `throw` that unwinds), the abort dispose drops the payload twice: once through the binding's slot and once through the scrutinee's slot. For a payload that owns heap memory (a `String` once B8 makes it a value) this is a double free; for any `Drop` type its `drop` runs twice.

**Status:** FIXED 2026-10-31 on `fix/consuming-match-move-flag`. Found the same day on `vbd/b8-arraylist-string-flip`: `tests/async_await.test.yo`'s "abort dispose skips awaitless-match pattern bindings (no double-drop)" failed under ASan with "attempting double-free" once its `Option(String)` payload became move-only. The bug predates B8: develop `9c78fdaf0` (and the v0.2.73 seed) drop a move-only `_MoFd` payload twice in the same shape.

## Reproducer

The test "move-only: an aborted task drops a consuming match's moved-out payload once" in `tests/move_only.test.yo`:

```yo
_mo_take_then_throw :: (fn(io : Io, exn : Exception) -> Impl(Future(i32, IoExn)))(
  io.async((e : IoExn) => {
    first := e.io.await(_mo_opt_fd(e.io), e.io);
    match(
      first,
      .None => i32(0),
      .Some(fd) => {
        e.io.await(yield(e.io), e.io);
        e.exn.throw(dyn(String.from("abort after the move")))
      }
    )
  })
);
```

On develop it fails with `dropped 2`; after the fix it is dropped once.

## Cause

`_sm_consuming_read` (`src/codegen/exprs/atom.yo`) renders a slot read that moves the value as `sm->var_first /*yo_mv:mN*/` and defers the slot's move statement (`sm->__yo_mv_var_first = 1;`, or a `memset` for a temporary's slot) to right after the emitted line carrying the marker. A match's scrutinee code is used directly in its test chain, so the marker's line was the first test, a conditional jump:

```c
if (!((sm->var_first /*yo_mv:m0*/).tag == NONE)) goto __yo_m_a0;
sm->__yo_mv_var_first = 1;  // moved out — runs on the fall-through (.None) path only
```

The `.Some` arm, reached by the jump, bound `fd` from the payload and stored it in its own slot, but the scrutinee slot was never flagged. Both slots then owned the payload, and the abort dispose dropped each.

## Fix

`generate_match_expression` (`src/codegen/exprs/match.yo`): when the scrutinee code carries a move marker, it is read once into a C local (`T __yo_scr_N = sm->var_first /*yo_mv:mN*/;`) before the test chain, and the tests and bindings read that local. The marker's line is now unconditional, so the slot gives up its value on every path, and only the binding's slot owns the payload.
