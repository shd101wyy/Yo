# `dyn(x)` cannot build a vtable when `x`'s impl comes from a GENERIC impl — the undeclared-wrapper crash, again

**Status:** OPEN
**Found:** 2026-09-05, extending the canary set for
`issues/fixed/dyn-does-not-check-that-the-value-implements-the-traits.md` (C69)
onto the generic-impl path that PR #429 had just touched.
**Severity:** crash-at-C-compile. `yo check` is clean; the build dies inside
clang naming a generated symbol the user never wrote. Same face as C69's symptom
1, different half of the mechanism.

## Symptom

```rust
{ ArrayList } :: import("std/collections/array_list");
open(import("std/string"));
open(import("std/fmt"));

show :: (fn(v : Dyn(ToString)) -> String)(v.to_string());

main :: (fn(io : Io) -> unit)({
  xs := ArrayList(i32).new();
  xs.push(i32(1));
  println(show(dyn(xs)));
});
export(main);
```

`yo check` — clean. `yo compile … --optimize 2`:

```
c11.out.c:601:37: error: use of undeclared identifier '__yo_wrap___yo_t12___yo_t15_to_string'
c11.out.c:607:37: error: use of undeclared identifier '__yo_wrap___yo_t0___yo_t15_to_string'
2 errors generated.
```

`Option(i32)` behaves identically (the second error above). Both types
implement `ToString` only through a blanket impl in `std/fmt/to_string.yo`:

```rust
impl(generic(T : Type), where(T <: ToString), ArrayList(T), ToString(to_string : …));
impl(generic(T : Type), where(T <: ToString), Option(T),    ToString(to_string : …));
```

Measured on `6c556431a` (pre-C69) and unchanged by C69.

## Why C69's check does not catch it

C69 made `dyn()` verify the bound with `type_implements_trait_bool`. That
predicate answers **`true`** here — correctly — through step 8,
`_find_matching_generic_impl`. The failure is one layer down, in the *value*
resolution:

`_resolve_dyn_trait_values` (`src/evaluator/values/dyn.yo`) looks the methods up
with `get_type_trait_methods_for_type(type_id_or_empty(concrete))`, a registry
keyed on the **concrete nominal id**. A blanket impl registers against the
GENERIC receiver, not against `ArrayList(i32)`, so the lookup misses, the trait
`?=` default fall-through finds nothing (`ToString.to_string` has no default),
and `.None` is pushed — the same `.None` that makes codegen's wrapper emitter
skip the method while its vtable emitter still names the wrapper.

So the predicate and the vtable builder DISAGREE: one proves the impl exists,
the other cannot find its `FuncVal`. C69 closed the case where both said "no";
this is the case where they differ.

## Fix

`_resolve_dyn_trait_values` must specialize the matching generic impl for the
concrete receiver and use the resulting `FuncVal`, the way
`_monomorphize_default_fv` already specializes a generic trait `?=` default
through `create_specialized_function_inline`. `_find_matching_generic_impl`
already identifies the impl; what is missing is materializing its methods for
this receiver and registering them under the concrete id.

A cheap interim guard is worth having regardless: when a required member of a
required trait resolves to `.None`, the emitted C is *known* to be broken for
every slot whose first parameter is `self`. Raising that as a compiler error at
the `dyn(...)` token — rather than letting clang report an internal `__yo_wrap_…`
name — needs the vtable emitter's own "is this slot named?" condition mirrored
in the evaluator so non-`self` members are not over-rejected.

## Regression test

`tests/dyn.test.yo`: `dyn(ArrayList(i32))` and `dyn(Option(i32))` into a
`Dyn(ToString)`, asserting the rendered text — verified RED first.
