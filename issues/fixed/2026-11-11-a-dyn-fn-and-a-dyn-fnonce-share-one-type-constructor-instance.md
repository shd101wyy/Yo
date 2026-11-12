# A `Dyn(Fn)` and a `Dyn(FnOnce)` share one type-constructor instance

**Severity:** S2 — a valid program that names `ArrayList(Dyn(FnOnce() -> R))` (or `Box(...)`, any type constructor) before `ArrayList(Dyn(Fn() -> R))` gets the `FnOnce` instance for both, so a second call through the `Fn` one is rejected with E0901.

Found 2026-11-11 by the decision 49 S1g sweep (`yo fix ./tests --migrate unsized`). The sweep wrote `tests/dyn.test.yo`'s `(o : Dyn(FnOnce() -> i32))` and `ArrayList(Dyn(Fn() -> i32))` as `Box(Dyn(...))`. `Box(...)` is a type-constructor call, so the second spelling memo-hit the first and the file stopped compiling. The bare `ArrayList` spelling fails the same way on v0.2.76.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
comptime_assert(!Type.eq(ArrayList(Dyn(FnOnce() -> i32)), ArrayList(Dyn(Fn() -> i32))), "two element types");
main :: (fn() -> unit)(());
export(main);
```

```
error: two element types
```

Calling through the second instance is the user-visible failure:

```
error[E0901]: use of moved value: cannot call `fs(usize(0))`: an `FnOnce(...)` call consumes the closure, and a closure stored in a field cannot be moved out of its holder (Yo has no partial moves).
```

## Cause

The CTFE memo (`_ctfe_args_equal`, `src/evaluator/calls/comptime_fn.yo`) compares a cached argument with a requested one through `are_types_compatible_exact`, i.e. `_compat_impl` in `Identity` mode. The `DynT` arm compares the trait sets element by element. The `FnTraitT` arm accepts any base name that `fn_trait_base_serves`, in every mode. A cached `FnOnce() -> i32` therefore "equals" a requested `Fn() -> i32`, because `Fn` serves `FnOnce`.

The opposite order does not collide, since `FnOnce` does not serve `Fn`. The mismatch only makes a program stricter (a `Fn` treated as `FnOnce` or `FnMut`), never looser, which is why this is S2. `Type.eq` was already right, because it compares in both directions.

## Fix

In `Identity` mode the `FnTraitT` arm requires the same base name (`src/types/compatibility.yo`). Flow and invariant keep `fn_trait_base_serves`.

Test: `tests/dyn.test.yo`, "a Dyn(Fn) after a Dyn(FnOnce) is its own constructor instance".
