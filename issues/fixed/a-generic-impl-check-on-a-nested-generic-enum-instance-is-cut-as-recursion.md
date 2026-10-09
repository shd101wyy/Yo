# A generic-impl check on a nested generic enum instance is cut as recursion

**Severity:** S2: a valid program was rejected. Under decision 36's flip, a copy of an `Option(Option(i32))` built inside a generic body was E0901, because the compiler answered that the type is not `Copy`.

> Found 2026-10-09 while landing `plans/VALUES_BY_DEFAULT.md` decision 36's
> flip: `tests/generic_instantiation_compat.test.yo`'s `_ww_thrice` failed.
> **FIXED same day.**

## Reproducer

```rust
_ww_wrap :: (fn(generic(U : Type), x : U) -> Option(U))(.Some(x));
_ww_thrice :: (fn(x : i32) -> Option(Option(Option(i32))))(_ww_wrap(_ww_wrap(_ww_wrap(x))));
main :: (fn() -> unit)({
  _a := _ww_thrice(i32(6));
});
export(main);
```

```
error[E0901]: use of moved value: cannot copy `x`, whose type `Option(U)` is copied only explicitly (`.clone()`) ...
note: in `_ww_wrap` with U = Option(U), instantiated here
```

## Root cause

Substitution keeps a generic enum instance's def-era id, so
`Option(Option(i32))` built by `wrap(wrap(x))` nests two `Option` instances
under one id (`enum_instance_node_id`'s doc, `src/types/type_key.yo`). The
recursion guard around `_find_matching_generic_impl`
(`g_trait_check_recursion_guard`, `src/evaluator/trait_checking.yo`) keyed a
check by the type's id and the trait. Checking the outer instance against
`impl(generic(T : Type), where(T <: Copy), Option(T), Copy())` checked the
bound `Option(i32) <: Copy`, whose key was the same, so it was cut as
recursion and answered false. The marker-trait guard beside it had the same
bug, already fixed by keying an enum instance by `enum_instance_node_id`
(`issues/fixed/a-generic-fns-option-result-at-a-specialized-option-is-a-second-c-type.md`).

## Fix

The generic-impl guard keys an enum instance by `enum_instance_node_id` (its
id and its type arguments' identities), as the marker guard does. The
registry lookup still uses `_type_id_for_trait_check`, which must mirror the
registration key.

## Verification

`tests/generic_instantiation_compat.test.yo` (6 tests) passes under the flip.
Before the fix, its `_ww_thrice` was the error above.
