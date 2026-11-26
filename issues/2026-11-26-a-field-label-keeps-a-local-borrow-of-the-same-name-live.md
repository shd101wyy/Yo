# A field label keeps a local borrow of the same name live

**Severity:** S2 — a local borrow `x := &p.x` stays live through any later statement that spells a field label `x :` (a constructor `Pair(x : …)`, a destructuring `{ x : s } := …`), so a valid write or borrow there is E0911; renaming the borrow works around it.

Found while implementing VERDICTS-76 Q2 (the lending destructuring `{ x : s, y : n } := &mut p` after a
`x := &p.x` whose last use came earlier).

```yo
{ println } :: import("std/fmt");
Pair :: struct(x : i32, y : i32);
main :: (fn() -> unit)({
  mut(p) := Pair(x : i32(1), y : i32(2));
  x := &p.x;
  println(`OUT: ${x.*.to_string()}`);
  p = Pair(x : i32(3), y : i32(4));
  println(`OUT: ${p.x.to_string()}`);
});
export(main);
```

`yo check` (develop `f9988b06a`):

```text
error[E0911]: Cannot write `p` here: `x` borrows `p.x` with `&` and is still live, and a `&` borrow freezes its place: while it is live, `p.x`, the places inside it and the places containing it are not written or moved.
  --> tmp/lbl3.yo:7:3
  |
7 |   p = Pair(x : i32(3), y : i32(4));
  |   ^
```

`x`'s last use is line 6; Rust accepts the same program.

## Root cause

A local borrow's live range ends at the last statement that mentions its name
(`local_borrow_range_of`, `src/evaluator/utils.yo`). The scan, `_lb_mentions` (and `_lb_last_mention`), skips
the field atom of a `.` call but recurses into both operands of a `label : value` pair, so the label `x`
counts as a use of the borrow `x`.

## Fix direction

Skip the label atom of a `label : value` argument (a constructor's or a call's named argument, a record
`.{ x : … }`, a destructuring binder's `{ x : s }`) in `_lb_mentions` and `_lb_last_mention`, as the field
atom of `.` is skipped; the value side stays scanned. A `(x : T) = v` / `(x : T) := v` binding's left side
declares a new `x` and is no use either. Test: the program above is accepted and prints `OUT: 1`, `OUT: 3`.
