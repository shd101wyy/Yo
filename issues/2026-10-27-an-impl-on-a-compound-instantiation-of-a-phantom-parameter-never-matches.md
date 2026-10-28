# An impl on a compound instantiation of a phantom parameter never matches

**Severity:** S2 — a valid program is rejected: a generic impl whose receiver pattern applies a type constructor to a compound argument (`_Sel(Option(T))`), where the constructor's parameter is mentioned by no field, matches no instantiation. The method call is E0610 "No method".

**Status:** open. **Found:** 2026-10-27, while writing static-argument inference A1's where-clause tests (`feat/sai-a1-static-arg-inference`).

## Reproducer

```yo
_Quiet :: trait(id := "sai_Quiet");
impl(bool, _Quiet());
_Sel :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(tag : i32)
);
impl(generic(T : Type), where(T <: _Quiet), _Sel(Option(T)), mk : (fn(x : T) -> Self)(Self(tag : i32(2))));
main :: (fn() -> unit)({
  b := _Sel(Option(bool)).mk(true);
});
export(main);
```

`yo check` on develop `476cfb700`:

```text
error[E0610]: No method "mk" on _Sel(Option(bool)): the type has no field or method with that name.
  --> tmp/sel2.yo:8:26
```

The same impl matches once a field mentions `T` (`struct(tag : i32, hold : Option(T))`), and an impl on the bare `_Sel(T)` matches `_Sel(Option(bool))` with `T := Option(bool)`.

## Root cause (not instrumented)

`_Sel(Option(bool))` = `struct(tag : i32)` carries its argument only in `Struct.type_arguments`. `try_match_generic_impl`'s receiver synthesis (`src/evaluator/values/impl.yo`) unifies the pattern with the receiver through their fields. A bare `T` argument appears to be bound from `type_arguments` positionally, but a compound one (`Option(T)`) is not unified against the receiver's argument, so `T` stays abstract and the impl is dropped as not all-bound.

## Fix direction

Unify the pattern's `type_arguments` with the receiver's, position by position, as the fields are unified, so that `Option(T)` against `Option(bool)` binds `T := bool`. The regression test is the reproducer as a `tests/` case.
