# An escape drop of a temp moved by macro-expanded code double-frees

**Severity:** S1 — an effect unwind out of a borrowed `for` body releases the loop's guard and iterator temps a second time, so the iterated collection is freed while the caller still holds it (use-after-free).

**Status: FIXED (2026-10-06).** Found while gating PR #1231 (S3 batch 2)
merged onto develop: the macOS language suite failed
`tests/for_macro_borrow.test.yo` "borrowed for: return from the body and
unwind through the body release the guard":

```
✗ borrowed for: return from the body and unwind through the body release the guard
  Test failed with exit code 6
  ArrayList: index out of bounds (at .../std/collections/array_list.yo:989:9)
```

## Reproducer

```rust
Raise :: (ctl() -> unit);
unwind_out :: (fn(xs : ArrayList(i32)) -> unit)({
  (raise : Raise) = (() -> { unwind(()); });
  for(xs, inout(x) => {
    x = i32(0);
    raise();
  });
});
main :: (fn() -> unit)({
  list := ArrayList(i32).new();
  list.push(i32(1));
  list.push(i32(4));
  unwind_out(list);
  printf("after rc=%d len=%d\n", ...);   // batch 2: rc=4 len=0 (freed); develop: rc=1 len=2
});
```

## Root cause

Batch 2's `issues/fixed/parser-internal-tests-report-a-40-byte-lsan-leak-locally.md`
fix stamps every consumed owning local of a frame into
`consumed_variable_drop_expressions` (`src/evaluator/exprs/begin.yo`, the M3
driver). Codegen then emits those drops at each effect-escape check before the
consumption (`generate_consumed_var_drops_for_escape`, `src/codegen/exprs/return.yo`).
The borrowed `for` lowers to `for_guard0 := <temp>` and
`for_iter_var0 := <temp>`, so its guard and iterator temps are consumed locals
too. Their consumption tokens come from macro-expanded code, which is not the
stream of the escape point (`raise()` in the user's body).
`_variable_moved_before_cleanup_point` therefore answered "not moved yet".
That emitted `__yo_decr_rc(temp)` beside the scope-drops of `for_guard0` and
`for_iter_var0._list`, which own the same counts. The extra decrements freed
the `ArrayList` the caller still held.

## Fix

The position gate now emits an escape drop only when the escape point is
PROVABLY before the consumption. `_consumption_is_ordered_against_cleanup_point`
requires the consumption token to share the escape point's token stream. When
the two cannot be ordered, nothing is emitted: a possible leak is preferred to
a possible double free. The batch's own case, a user local moved out through
the return value while a throw unwinds (`tests/error.test.yo`), is in one
stream and keeps its drop.

Test: `tests/for_macro_borrow.test.yo` "borrowed for: return from the body and
unwind through the body release the guard". It fails on the merged tree
without the gate and passes with it.
