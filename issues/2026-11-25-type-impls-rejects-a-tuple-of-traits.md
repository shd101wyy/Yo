# `Type.impls(i32, (Clone, Copy))` is "Cannot store a type value in tuple"

**Severity:** S3 — a misleading, uncoded diagnostic: `Type.impls` takes one trait, and the tuple form that `where(T <: (A, B))` and `Dyn(A, B)` accept is reported as a tuple storing a type value.

**Found:** 2026-11-25, VERDICTS-85, probe `i1c`.
**Measured:** `yo 0.2.79` built from develop, `--std-path` of develop `fc89e3195`.

## Symptom

```yo
Shape :: trait(area : (fn(self : &Self) -> i32));
Circle :: struct(r : i32);
impl(Circle, Shape(area : (fn(self : &Self) -> i32)(self.r)));
comptime_assert(Type.impls(Circle, Shape), "one trait works");
comptime_assert(Type.impls(i32, (Clone, Copy)), "a tuple of traits");
main :: (fn() -> unit)(());
export(main);
```

```text
error: Cannot store a type value in tuple, please use module instead:
  Clone
  --> m3.yo:5:34
  |
5 | comptime_assert(Type.impls(i32, (Clone, Copy)), "a tuple of traits");
  |                                  ^^^^^
yo: error: check: 1 file(s) failed evaluator coverage
```

The first assert (one trait, including applied ones such as `Eq(i32)`) passes.

## Root cause

`evaluate_yo_type_impls` (`src/evaluator/builtins/type-fns.yo`) evaluates its second argument as an ordinary expression and expects a single trait type ("expected trait type for second argument"). `(Clone, Copy)` is a tuple literal there, and the tuple evaluator (`src/evaluator/values/tuple.yo`) rejects any element that is a type value with "Cannot store a type value in tuple, please use module instead". The grouping that `where(...)` and `Dyn(...)` read as a bound list is only a bound list at those sites.

## Fix direction

Either (a) `Type.impls` accepts a tuple of traits as "implements all of them", read before the argument is evaluated as a value, or (b) keep one trait and give the failing site a coded diagnostic: "`Type.impls` takes one trait; write `Type.impls(T, A) && Type.impls(T, B)`". (a) matches the bound grammar; the choice is the maintainer's, and the diagnostic must not mention tuples either way.

## Test to add with the fix

`tests/type-reflection.test.yo` (or the file that holds the `Type.impls` cases): `comptime_assert(Type.impls(i32, (Clone, Copy)))`, a negative `!Type.impls(Circle, (Shape, Clone))`, and, if (b) is chosen, a `comptime_expect_error` on the tuple form.
