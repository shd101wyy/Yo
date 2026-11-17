# `Type.get_info(str)` reports the legacy `&(str, static)`, not `str`, after the `str` flip

**Severity:** S2 — compile-time reflection gave a wrong answer for `str`: `Type.get_info(str)` was a `.Reference`, so
`is_str()` and `is_primitive()` were false and `tests/type_reflection.test.yo` failed to compile.

**Status:** FIXED on `fix/develop-v0279-reds`. Found red on develop `916b279c1` (#1980, the `str` flip).

## Reproducer

```yo
main :: (fn() -> unit)({
  comptime_assert(Type.get_info(str).is_str(), "str should be Str");
  comptime_assert(Type.get_info(str).is_primitive(), "str should be primitive");
});
export(main);
```

```text
error: str should be Str
```

## Root cause

`Type.get_info` was declared `(fn(comptime(self) : Type) -> comptime(TypeInfo))`. A `comptime(V) : Type` binder carries
`V <: Sized` (decision 49), and since #1980 `evaluate_comptime_fn_call` (`src/evaluator/calls/comptime_fn.yo`) reads the
unsized `str` passed to such a binder as the legacy value `str`, `&(str, static)`. `__yo_type_get_info` therefore saw a
reference and built `TypeInfo.Reference(str, false, static)`. Its pointee could not be inspected either: passing it back
to `Type.get_info` re-applied the alias. `Type.impls`, `Type.eq` and `Type.neq` already took `comptime(…) : ?Sized`
(#1970); `get_info` was missed.

## Fix

`get_info : (fn(comptime(self) : ?Sized) -> comptime(TypeInfo))` in `std/prelude.yo`. Reflection takes any type, unsized
ones included, so `Type.get_info(str)` is `.Str` and `Type.get_info(&str)` is `.Reference(str, false, …)`. The v0.2.78
seed already accepts a `?Sized` comptime binder, so the change is seed-safe.

## Verification

`tests/type_reflection.test.yo`: 0 of 37 ran (the batch failed to compile) on `b2155b8bf`; 37/37 pass with the fix.
