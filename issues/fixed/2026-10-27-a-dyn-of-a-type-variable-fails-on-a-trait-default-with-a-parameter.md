# A `dyn` of a type variable fails on a trait default with a parameter

**Severity:** S2. A `dyn(v)` written inside a generic body, where `v`'s type is still the type variable `T`, fails to check when the trait has a `?=` default method with a parameter after `self`. The error is `Variable "out" not found`, raised at the default's body, and the generic function cannot be compiled at all. No workaround exists short of overriding the default in every impl. Every `Dyn(ToString)` written under `where(T <: ToString)` hit it as soon as `ToString` gained its `append_to` default (lookahead D10), which is how it was found.

**Status:** FIXED 2026-10-27 (`vbd/b8-d10-interpolation-builder`). **Found:** 2026-10-27, while adding `ToString.append_to`: `tests/dyn.test.yo`'s `_generic_show` stopped checking. The v0.2.70 and v0.2.71 seeds reject the reproducer's generic function; the concrete `dyn(p)` alone checks.

## Reproducer

```yo
{ println } :: import("std/fmt");
Show :: trait(
  show : (fn(self : &Self) -> i32),
  (show_into : (fn(self : &Self, out : &mut i32) -> unit)) ?= ((self, out) -> {
    out = (out + self.show());
  })
);
P :: struct(x : i32);
derive(P, Copy, Clone);
impl(P, Show(show : (fn(self : &Self) -> i32)(self.x)));
_use :: (fn(v : &Dyn(Show)) -> i32)({
  mut(acc) := i32(1);
  v.show_into(&mut acc);
  acc
});
_g :: (fn(generic(T : Type), v : &T, where(T <: Show)) -> i32)(_use(dyn(v)));
main :: (fn() -> unit)({
  p := P(x : i32(41));
  println(_g(&p));
  println(_use(dyn(p)));
});
export(main);
```

```text
error[E0401]: Variable "out" not found.
  --> repro.yo:5:5
  |
5 |     out = (out + self.show());
  |     ^^^
   --> repro.yo:16:64
   |
16 | _g :: (fn(generic(T : Type), v : &T, where(T <: Show)) -> i32)(_use(dyn(v)));
   |                                                                ^^^^
```

## Root cause

A `dyn(v)` builds the vtable of the receiver's type. For a concrete receiver, the impl already carries the default materialized for that type (`src/evaluator/values/impl.yo`, per-impl materialization), so the vtable takes it as it is. For a type variable there is no impl: the lookup falls through to the trait's raw default, and `_monomorphize_default_fv` (`src/evaluator/values/dyn.yo`) specializes it for the receiver through `create_specialized_function_inline`. That call was given one argument, `self`, so the specialization bound `self` and nothing else. The body of a default with any further parameter then read an unbound name. `Error.source`, the one std default in a vtable until then, takes only `self`, which is why nothing failed before.

## Fix

`_monomorphize_default_fv` binds every parameter of the default, `self` included, in a scratch frame of the environment it specializes in. It uses the parameter's declared type with `Self` read as the receiver (`_substitute_self_in_method_ty`, now exported from `impl.yo`), and the same `is_parameter`/`is_ref`/`is_imm_borrow` flags the per-impl materialization in `impl.yo` sets. It also passes one runtime argument per parameter. `create_specialized_function_inline` takes a parameter's binding from the environment its caller prepared, which is how a real call reaches it, so a specialization with nothing bound read an unbound name. (A first draft passed only the extra arguments; the body still could not see the names.)

## Test

`tests/dyn.test.yo`, "a dyn of a type variable binds every parameter of a trait default": the reproducer's shape, plus a `Dyn(ToString)` rendered as a later template part. It fails to check on the v0.2.71 seed and passes after the fix; the reproducer, built with `--sanitize address`, prints `42` twice on the fixed binary.
