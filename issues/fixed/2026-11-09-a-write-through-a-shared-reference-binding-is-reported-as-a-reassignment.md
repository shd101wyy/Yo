# `x.* = v` through a `&` reference binding is reported as "Cannot reassign" (E0902)

**Severity:** S3 — the program is rejected correctly, but the diagnostic names the wrong rule and gives the wrong help.

**Status:** fixed (G2, `g2-into-iter`).

## Symptom

```yo ignore
h :: (fn(r : &i32) -> unit)({
  r.* = i32(2);
});
```

```text
error[E0902]: Cannot reassign "r": it is a parameter, which cannot be reassigned.
help: rebind it to a mutable local and assign that (`mut(r_m) := r;` ...), or take `r : &mut T` ...
```

The same for a `&` payload binding (`match(it.next(), .Some(x) => { x.* = i32(2); }, …)`, the element of
`for(&xs, x => { x.* = … })`, which the retargeted borrowed `for` now binds as a match payload): "Cannot reassign
"x": it is an immutable binding". A `r := &y; r.* = …` local borrow already gave E0908
("`r` is a `&` borrow, which is read-only").

## Cause

`r.* = v` arrives at `assignment.yo`'s variable-assignment arm as a write to the binding `r` (the deref is only
a flag the arm takes); the "is reassignable" test then fails for the immutable `&` binding before anything looks
at the binding's reference type.

## Fix

In that arm, a `.*` write through a binding whose slot type is a shared reference raises E0908 ("Cannot assign to
`r`: `r` is a `&` borrow, which is read-only"). Test: `tests/for_read_walk.test.yo`
(`read_walk_element_write`, `read_walk_map_value_write`, `shared_reference_parameter_write`).
