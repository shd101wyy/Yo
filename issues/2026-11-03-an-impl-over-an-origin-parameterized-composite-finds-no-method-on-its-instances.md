# An impl over an origin-parameterized composite finds no method on its instances

**Severity:** S2: valid programs are rejected. A method declared by `impl(generic(p : Origin), V(p), …)` cannot be called on any `V(x)` value, so decision 43 step 4's (N3) cursors, views and entries cannot carry methods.

## Reproducer

`issues/repros/2026-11-03-an-impl-over-an-origin-parameterized-composite-finds-no-method-on-its-instances.yo`:

```yo
V :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(at : &(i32, p), lo : usize));
impl(generic(p : Origin), V(p), lo_plus : (fn(self : &Self, k : usize) -> usize)(self.lo + k));
main :: (fn() -> unit)({
  x := i32(1);
  v := V(x)(at : &x, lo : usize(2));
  n := v.lo_plus(usize(1));
});
export(main);
```

```text
error[E0610]: No method "lo_plus" on V(origin(p)): the type has no field or method with that name.
```

The same happens with a type parameter beside the origin, as in `impl(generic(T : Type, p : Origin), G(T, p), …)`. It reproduces on develop `dd9ca178c` (N2a + N2b) and on the N1e-1 branch `a2d3cc1e0`.

## What is wrong

- N2b (#1720) says impl-level `generic(p : Origin)` binders "bind the origin abstractly (the `impl` phase error is lifted)". The impl evaluates, but nothing ties its methods to the instances.
- The diagnostic names the receiver `V(origin(p))`, the impl's abstract instance, not `V(origin(x))`. This is consistent with N2b's T3 erasure: the constructor memo compares arguments with origins erased. So the value and the impl probably share one memoized instance, and the method lookup misses for a reason other than the type's identity. The root cause is still open.
- No test covers a method on an origin-parameterized composite. The N2b tests read fields only (`tests/borrow_spelling.test.yo`, `BsView`).

## Fix

**v0.2.75, hard gate** (VERDICTS-14 Q1). Owned by decision 43 step 4's branch (`vbd/d43-step4-n3`). The fix lands with a `tests/borrow_spelling.test.yo` case that calls a method of each repro shape.
