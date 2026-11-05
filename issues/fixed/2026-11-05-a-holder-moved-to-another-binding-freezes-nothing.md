# A holder moved to another binding freezes nothing

**Severity:** S2. An invalid program is accepted: after `w := v` moves an origin-carrying holder, the places it borrows can be written while `w` is still live.

> Found 2026-11-05 while building decision 43 step 4's `Future(T, p)` (N3-1), where a bound borrowing future moved to another binding (`g := f`) had the same hole.

## Reproducer

```yo
_Two :: (fn(comptime(p) : Origin, comptime(q) : Origin) -> comptime(Type))(struct(a : &(i32, p), b : &(i32, q)));
main :: (fn() -> unit)({
  mut(x) := i32(1);
  mut(y) := i32(1);
  v := _Two(x, y)(a : &x, b : &y);
  w := v;
  x = i32(2); // accepted, as is a write of `y`; E0911 is expected: `w` is used below
  _r := w.a.*;
  ()
});
export(main);
```

## Root cause

There were two gaps, and either one alone loses a freeze.

1. **No live range.** A borrow binding's range comes from the block look-ahead (`local_borrow_set_lookahead`). `evaluate_begin_expression` armed it only for `name := call(...)` and for the explicit borrow bindings, so `w := v` (an atom on the right) got a range that ends at its own statement. `v`'s own freeze ends at `w := v`, its last use, so nothing was frozen afterwards.
2. **One root only.** `_holder_roots_into`, which reads the places a holder froze, took only the holder's latest local-borrow entry. A holder of two places registers one entry per place, so a move or copy of it carried only the last place.

## Fix

Both gaps are fixed in `src/evaluator/utils.yo`:

- `local_borrow_may_bind_projection_stmt` also arms the look-ahead for `name := atom`.
- `_holder_roots_into` collects the holder's whole run of entries, the ones its binding registered together, each with its own mode.

Tests:

- `tests/borrow_spelling.test.yo`: "a holder moved to another binding keeps both its places frozen", `bs_moved_holder_freezes_first` and `bs_moved_holder_freezes_second` (E0911). On develop `2b9db068d`, the first E0911 case fails.
- `tests/async_await.test.yo`: the moved bound future case in "a bound borrowing future freezes what it borrows until its last use".
