# An impl over an origin-parameterized composite finds no method on its instances

**Severity:** S2: valid programs are rejected. A method declared by `impl(generic(p : Origin), V(p), …)` cannot be called on any `V(x)` value, so decision 43 step 4's (N3) cursors, views and entries cannot carry methods.

**Status:** FIXED 2026-11-03 (vbd/d43-step4-n3, N3-0): an origin binder of a generic impl gets no placeholder `SomeT`, so the receiver pattern binds every binder.

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

N2b (#1720) says impl-level `generic(p : Origin)` binders "bind the origin abstractly (the `impl` phase error is lifted)". The generic-impl registration (`values/impl.yo`, Case 2) does bind `p` abstractly in the forall env. It ALSO pushes a placeholder `SomeT` named `_` into the entry's `forall_names`/`forall_some_types`, because the binder's name slot is `.None`.

The receiver pattern `V(p)` never mentions that placeholder, so synthesis never binds it. `try_match_generic_impl` then ends with `all_bound=false` (`YO_DEBUG_DISPATCH`: `[tm-end] … all_bound=false`) and rejects the impl for every receiver.

The receiver name in the diagnostic, `V(origin(p))`, is a separate rendering defect: `issues/fixed/2026-11-03-a-second-instance-of-an-origin-parameterized-composite-names-the-first-ones-origin.md`.

## Fix

**v0.2.75, hard gate** (VERDICTS-14 Q1). An origin binder gets no `SomeT` (`fp_is_origin`, `values/impl.yo`): it is bound only abstractly. The fix lands with a `tests/borrow_spelling.test.yo` case that calls a method of each repro shape (decision 43 step 4's branch, `vbd/d43-step4-n3`).
