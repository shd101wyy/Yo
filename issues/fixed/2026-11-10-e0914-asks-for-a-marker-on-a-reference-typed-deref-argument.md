# E0914 asks for a marker on a reference-typed `lhs.*` argument, and its advice `&lhs.*` is wrong

**Severity:** S3. A valid spelling is rejected and the advice for it does not compile; `&lhs.*.*` works.

Found 2026-11-10 by Fable 5.2 (VERDICTS-49 gap 4) while probing G2 piece 3's blanket `Eq`.

## Reproducer

```yo
{ assert } :: import("std/assert");
rr_eq :: (fn(lhs : & &i32, rhs : & &i32) -> bool)(i32.(==)(lhs.*, rhs.*));
test("lhs.* is a &i32", {
  x := i32(7);
  rx := &x;
  assert(rr_eq(&rx, &rx), "eq");
});
```

```
error[E0914]: Parameter "lhs" is a `&` borrow (`lhs : &T`): lend `lhs.*` with `&lhs.*`.
```

The advice `&lhs.*` is a `&&i32` for a `&i32` slot, which is E0601.

## Root cause

`_marker_place_of` (`src/evaluator/calls/helper.yo`) classed an argument by its syntax: a `.` step on a place is
a `.Place`, so `lhs.*` (type `&i32`) was a place to lend. Only a reference FIELD read was exempt. The read rule
(VERDICTS-23 R1, stated by type) says a `&T`-typed expression is the reference value where a `&T` slot expects it.

## Fix

Two layers, both stated by type:

1. `_marker_place_of` (`src/evaluator/calls/helper.yo`) tests the argument's `ExprInfo.ty` first: a `&T` reference is
   `.Borrow` (a `&mut` reference only as a reference-field read, as before; a `&mut T` below a `&` is not `Copy`, so
   its bare read stays E0901 and `&lhs.*.*` is the spelling there); the syntactic arms follow
   (`_marker_place_of_syntax`), and the old reference-field arm folds into the type test.
2. `_projection_result_as_reference` (`src/evaluator/exprs/_expr.yo`) records the reference read for a `.*` whose own
   type is already a reference where the position expects one. Without it the marker check passed but the slot saw
   E0601 "`i32` vs `&i32`": the read was never noted, so the argument was matched as the place, not the reference.

Test: `tests/origins/reference_read_rule.test.yo` (a run-time canary that the callee receives the loaded pointer
`*lhs`, not `lhs`; `i32.(==)(lhs.*, rhs.*)` on equal and unequal referents; `&lhs.*.*` stays legal).
