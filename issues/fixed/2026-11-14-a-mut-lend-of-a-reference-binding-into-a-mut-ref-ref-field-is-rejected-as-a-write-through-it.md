# A `&mut` lend of a reference binding into a `&mut &T` field is rejected as a write through it

**Severity:** S2. `M(rp : &mut r)` with `M :: struct(rp : &mut &Rc(X))` and `mut(r) := &outer` is rejected with
E0908 ("Cannot store `r` in the `&mut` field `rp`: `r` is a `&` borrow, which is read-only"), although `&mut r`
lends the binding `r` itself (§7 P3), not the place `r` points at. The same lend in a declaration
(`rp := &mut r`) or as a call argument is accepted. Introduced by #1929 (A26).

Found 2026-11-14 by the `flow` lane (cluster 4): the G-B row `a25-store-through-local-mut-borrow-ref-ref-field`
(E0911 expected) began to report E0908 once `fix/c4-flow-join` merged develop `688aba288`.

## Reproducer

`tests/origins/unsound/c4-mut-ref-ref-field-lend-pos.yo` (positive, expects accept):

```yo ignore
M :: struct(rp : &mut&Rc(X));
main :: (fn() -> unit)({
  outer := mk();
  other := mk();
  mut(r) := &outer;
  {
    m := M(rp : &mut r);
    ri := &other;
    m.rp.* = ri;
  };
  println(`OUT: ${r.*.*.s.len().to_string()}`);
});
```

## Root cause

#1929 made a `&mut` field's argument an exclusive write of its place in `try_to_call_type_with_arguments`
(`src/evaluator/calls/type.yo`): a place whose root is a shared reference is read-only there
(`local_borrow_require_writable(…, local_borrow_root_is_shared_reference(…))`). For `&mut r` the place IS the
reference binding `r`, whose root is a shared reference, so the check read the lend as a write through `r`. The
declaration form's check (`src/evaluator/exprs/initialization_assignment.yo`) already exempts that case with
`!is_reference_self_place(…)`.

## Fix

The `&mut` field check takes the same exemption: a `&mut` lend of a reference binding's own place
(`is_reference_self_place`) is a write of the binding, which is `mut(r)`, not of its referent.

## Test

`tests/origins/unsound/c4-mut-ref-ref-field-lend-pos.yo` (accept, G-B), and
`a25-store-through-local-mut-borrow-ref-ref-field.yo`, which reports its E0911 again.
