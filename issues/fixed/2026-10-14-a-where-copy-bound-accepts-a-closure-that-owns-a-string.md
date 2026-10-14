# `where(T <: Copy)` accepts a closure that owns a `String`

**Severity:** S2 — a `Copy`-bounded generic accepted a closure whose capture record is not `Copy`, so a bound-checked body could copy it bitwise

**Found:** 2026-10-14, reviewing v0.2.62 (`~/Workspace/Yo-wt/review-v0262/fnprobe/h.yo`).
**Status:** FIXED 2026-10-14.

## Symptom

```yo
{ String } :: import("std/string");
need_copy :: (fn(comptime(T) : Type, x : T, where(T <: Copy)) -> T)(x);
main :: (fn() -> unit)({
  s := String.from("hi");
  (c : Impl(Fn() -> usize)) = ({ s }() => s.len());
  k := need_copy(type_of(c), c);
});
export(main);
```

passed `check`, as did the `generic(T : Type)` spelling, although
`Type.impls(type_of(c), Copy)` is false. `need_copy(String, s)` was E0602.

## Cause

A closure's type is an `Impl(Fn(...))` SomeT bound to its capture record. The
where-clause gates judge a function type through its values
(`call_function_value_marker`, for `Send`/`Sync`/`Acyclic`), and otherwise
check only a fully concrete bound: the comptime-parameter gate
(`validate_where_constraints_for_call`, `src/evaluator/calls/helper.yo`) skips a
SomeT, and the generic-parameter paths (`src/evaluator/types/function.yo`)
push the bound onto the SomeT without judging it. `Copy` was never asked of
the closure.

## Fix

`function_value_marker` (`src/evaluator/utils/closure.yo`), which every
where-clause path consults for a function type, judges `Copy` and `Clone` of a
bound closure identity by its capture record: the verdict names the `&mut`
capture or the first by-value capture that is not `Copy` (`Clone`). The call is
E0602: "The function type … does not implement required trait Copy: its
capture `s` has type `String`, which is not Copy; …".

Tests: `tests/copy_trait.test.yo` ("where(T <: Copy) rejects a closure that
owns a String").
