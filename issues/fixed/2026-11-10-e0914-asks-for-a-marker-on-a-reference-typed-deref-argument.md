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

Two parts, both stated by type:

1. **The marker check.** `_marker_place_of` (`src/evaluator/calls/helper.yo`) tests the argument's `ExprInfo.ty`
   first: a shared `&U` reference is `.Borrow`, whatever its syntax; the syntactic arms follow
   (`_marker_place_of_syntax`, which keeps the reference-FIELD arm: a field read is typed as its pointee, so the
   type test does not see it). A `&mut U` below a `&` is not `Copy`, so it stays with the syntactic arms, and
   `&mut lhs.*.*` is its spelling.
2. **The binding.** A `&U` parameter's slot type is its pointee `U`: the slot takes a place of type `U`. So the
   argument `lhs.*` (a `&U` value) binds as the place it refers to, `lhs.*.*`, which is exactly what `&lhs.*.*`
   spells once the call-site marker is peeled. `reference_argument_as_referent` does that rewrite at both
   argument binders (`check_if_function_parameter_matches_argument` and the inline `FuncVal` loop in
   `src/evaluator/calls/function.yo`), for a shared reference at a concrete, non-owning, non-`&mut` slot whose
   pointee is the reference's referent. A receiver (evaluated before its call), a `& &U` slot and a generic slot
   are left alone. The callee receives the pointer the reference holds (`*lhs`), never `lhs`.

A first attempt recorded the reference read in `_projection_result_as_reference` instead; it never applied,
because the read rule fires only where the expected type is itself a reference, and a `&U` parameter's
expected type is `U`. With only the marker check fixed, the argument check reported E0601
"Expected `i32`, Given `&i32`".

Test: `tests/origins/reference_read_rule.test.yo`. It is a run-time canary that the callee reads the referent
through the loaded pointer. It also checks `i32.(==)(lhs.*, rhs.*)` on equal and unequal referents, and that
`&lhs.*.*` stays legal.
