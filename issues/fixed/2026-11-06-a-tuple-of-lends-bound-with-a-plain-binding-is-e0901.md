# A tuple of lends bound with a plain `:=` is E0901

**Severity:** S2: a valid program is rejected. A tuple literal whose
elements lend (`t := (&x, i32(0))`) fails to bind: the `:=` transfer reads
the literal's temp as non-owning storage and rejects the move with E0901
"cannot copy … it is borrowed from the value that holds it". The same
literal in return position (a block tail, a function result) binds and
moves fine. `mut(t) := ...` fails the same way, and so does a `&mut` lend
element (`t := (&mut x, i32(0))`).

> Found 2026-11-05 by the N2b-r lane while landing the tuple-lend rows
> (`get2-mut-pair`, `bs_tuple_lend_freezes`): the borrow_spelling batch
> failed on it on every N2b-r build (w1–w8). On develop's PR2b build the
> tuple lend is rejected earlier ("`&x` … is not an expression of its
> own"), so the E0901 only surfaces on a tree that accepts tuple lends
> (N2b-r's own change).

## Reproducer

```yo
main :: (fn() -> unit)({
  mut(x) := i32(7);
  t := (&x, i32(0));
  ()
});
export(main);
```

```text
error[E0901]: use of moved value: cannot copy `&(x), i32(0)`, whose type `Tuple(0 : &i32, 1 : i32)` is move-only (it is neither `Copy` nor `Clone`), and it cannot be moved either: it is borrowed from the value that holds it (an element, or a binding into another value).
```

Adding any reference type in a TYPE position to the same module — a struct
field `S :: struct(r : &i32, v : i32)`, or a spelled origin argument
`Option(&(i32, x))` — makes the binding pass. A module whose only
reference-y construct is the lend itself always failed.

## Root cause

`type_carries_origin` (`src/types/utils.yo`) is gated on the global
`g_origin_types_exist` knob: until some type outside a parameter/result
slot holds a reference or an origin argument, it answers `false` for every
type without walking. The knob was armed only by `evaluate_reference_type`
(a `&T` written in a type position) and `evaluate_origin_argument` (an
`Origin` argument of a type constructor). A LEND in an expression — the
tuple element `&x`, a struct constructor's reference field — builds its
`Reference` type in `lend_place_reference_type` without arming the knob.

`attach_temp_variable_to_expr` decides whether a fresh literal's temp OWNS
its value by
`type_carries_origin(&effective_ty) && type_requires_explicit_copy(&effective_ty)`
(`src/evaluator/utils.yo`). In a module that never wrote a reference type
in a type position, the knob is still off at the tuple literal's attach,
so the temp is created non-owning. The `:=` transfer
(`transfer_explicit_copy_value`) then reads that temp as borrowed storage
and throws E0901. The knob is never cleared, so the same module with any
earlier type-position reference works — which is why the bug hid behind
borrow_spelling's other rows on some builds and surfaced on others.

## Fix

A lend arms the knob: `lend_place_reference_type` calls
`note_origin_types_exist()` at both of its reference constructions (the
place lend and the raw-pointer referent). A reference type now exists in
the evaluator from the first lend on, so a later composite of lends
carries origins at its temp attach, the temp owns it, and the binding
moves it (the temp is consumed, no dup, no drop of the place).

Tests (`tests/borrow_spelling.test.yo`): "a tuple literal lends its
reference elements" binds `t := (&x, &y, i32(5))` and reads it back, and
`bs_tuple_lend_freezes` writes `x` while `t` is live (E0911, the freeze).
Both failed with E0901 before the fix and pass after.
