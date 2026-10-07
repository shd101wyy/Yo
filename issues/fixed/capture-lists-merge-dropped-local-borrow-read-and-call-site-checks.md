# #1259's merge dropped the local-borrow read check and the call-site rules (#1255)

**Severity:** S2 — invalid programs accepted: a read of a place under a live `mut` local borrow, and a borrow of a module-level / cell place live across a runtime call or `await`, were no longer rejected (E0911), and `develop` went red on every platform.

> Found 2026-10-07 while getting `develop` green for v0.2.54. **FIXED same day.**

## Symptom

Every `test (...)` leg, both wasm legs, and the self-hosted hollow sweep failed
on `develop` at `6be4efee1` with the same two files:

```
tests/local_borrows.test.yo
error: "Cannot read `x` here"
   --> tests/.yo_selftest_batch_3729_170_0.yo:25:1
25 | comptime_expect_error(read_under_mut_rejected :: (fn() -> unit)(begin(x := i32(1), mut(y) := x, _v := x, y = i32(2), ())), "Cannot read `x` here");
yo: error: test: tests/local_borrows.test.yo — 0 of 16 tests in this batch ran: the batch failed to compile
```

and the same for `tests/ref_local_binding.test.yo` (`"Cannot read `s` here"`).
The expected E0911 never fired, so each `comptime_expect_error` failed its batch.
The CLI case `local-borrow-across-an-await-through-a-cell-is-e0911` lost its
diagnostic too.

Minimal reproducer (accepted by the tree compiler at `6be4efee1`; must be
rejected with E0911):

```rust
main :: (fn() -> unit)({
  x := i32(1);
  mut(y) := x;
  _v := x;
  y = i32(2);
});
export(main);
```

## Root cause

#1255 (local borrows) and #1259 (closure capture lists) were developed in
parallel and merged back to back. #1259's squash commit `7e328a541` removed
lines that #1255 had added and that #1259's branch had never seen. Its diff
against its parent deletes:

- `src/evaluator/exprs/identifer_and_operator.yo`: `lb_is_receiver :=
  local_borrow_take_receiver(expr)` and the whole-variable
  `local_borrow_access(..., LocalBorrowAccess.Read, ...)` call (decision 18's
  read rule). Without it, no read of a local is checked against a live `mut`
  borrow.
- `src/evaluator/calls/function.yo`: `_local_borrow_note_call_site` and its
  call in `evaluate_function_call`'s `.None` arm (decision 18 rules 3 and 4: no
  borrow of a module-level place live across a runtime call, none through a
  reference cell or module-level place live across an `await`).

The import lists kept `local_borrow_take_receiver`, `local_borrow_access` and
`local_borrow_note_runtime_call`, so `check` stayed green while the hooks were
gone. The other merges in that batch (#1253, #1254, #1260, #1261, #1262) were
scanned the same way (lines added since `57a2af47a` and deleted by each
merge). They show only deliberate rewrites.

## Fix

Restore both hunks verbatim from `a241d769e` (#1259's parent), keeping #1259's
`check_capture_freeze_access` call in place. `src/diagnostics_registry.yo` also
had a stray blank line in its import list from the same merge; the fmt gate
flagged it.

## Verification

- The reproducer above is rejected with E0911.
- `yo test tests/local_borrows.test.yo` and `tests/ref_local_binding.test.yo`
  pass with the rebuilt tree compiler. Both fail before the fix, so they are
  the regression tests.
- `local-borrow-across-an-await-through-a-cell-is-e0911` matches its golden again.
