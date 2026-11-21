# A typed reference local bound to a reference value crashes the member read

**Severity:** S3 (a broken diagnostic: an internal "Last expression in begin" error where a verdict belongs).

**Status:** FIXED 2026-11-21 by the P12 lane (the fix and the test land in the same PR).

## The repro (t1)

```yo
pragma(Pragma.AllowUnsafe);
X :: struct(n : i32);
f :: (fn(r : &X) -> i32)({
  (l : &(X, static)) = r;
  l.n
});
main :: (fn() -> unit)(());
export(main);
```

`yo check` (the v0.2.79 seed and the integration binary of 2026-11-21 agree):

```text
error: Last expression in "begin" is not evaluated correctly:
(l.n)
```

and with the read off the tail, `n2 := l.n;` fails with `Failed to evaluate, got (l.n)`: the member read never
receives an ExprInfo. `l.*.n` on the same binding evaluates, so does `m := r; m.n`, and `l.len()` reports
`No method "len" on &X` — the auto-dereference a flow-inferred binding's receiver read performs is skipped for a
local declared `(l : &X)`/`(l : &(X, o))` and bound to a reference VALUE (not a place lend), and the field-lookup
failure is then swallowed instead of reported.

The crash is not specific to `static`: `(l : &(X, r)) = r; l.n` (a named origin) and `(l : &X) = r; l.n` (elided, a
safe file) fail identically.

## The fix

`m := r` binds through `_bind_projection_result` (the `:=` chain's every leaf read as a
reference, R-TAIL), which stamps the reference-binding flags (`variable_set_is_ref`,
`variable_set_reference_mut`). The typed declaration `(l : &X) = r` — whose
expected-type read makes `r` a reference just the same — went through
`evaluate_assignment`, which added the variable WITHOUT those flags: a plain local of
reference type, a shape no reader of a receiver knows. `evaluate_assignment` now stamps
the flags on a typed declaration whose declared slot is a borrow and whose
right-hand side read is a reference read (`src/evaluator/exprs/assignment.yo`), making
the binding exactly what `m := r` produces.

## The test

`tests/local-borrows.test.yo`, "a typed reference local bound to a reference value
reads through it" (`(l : &Point) = r; l.x`), plus the spelled-static row
(`(l : &(Point, static)) = r` is the checked-origin rule's E0923). The row fails with
`Last expression in "begin" is not evaluated correctly` before the fix and passes
after.
