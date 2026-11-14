# A reference type argument at a `?Sized` parameter loses its `&`

**Severity:** S2 (a valid program is rejected: a user `impl(&C, Eq(&C))`, the
shape `tests/impl_ref.test.yo` exercises since #1933, fails with E0602)

**Filed:** 2026-11-14 by the decision 49 S2 lane (`vbd/d49-s2`), from
VERDICTS-62 §2 decision 6 and §3 (measured on the lane's b5 binary). Introduced
by this branch: develop's `Eq` takes `comptime(Rhs) : Type`, and S2 made it
`?Sized`.

## Symptom

```yo ignore
_PgC :: struct(n : i32);
impl(
  &_PgC,
  Eq(&_PgC)(
    (==) : (fn(lhs : &Self, rhs : &Self) -> bool)(lhs.*.*.n == rhs.*.*.n),
    (!=) : (fn(lhs : &Self, rhs : &Self) -> bool)(lhs.*.*.n != rhs.*.*.n)
  )
);
```

reported E0602: "member `==` has type `fn(lhs : &&_PgC, rhs : &&_PgC) -> bool`,
but the trait requires `fn(lhs : &&_PgC, rhs : &_PgC) -> bool`". `Eq(&_PgC)` had
become `Eq(_PgC)`; an `Eq(&Bar)` impl beside `Eq(Bar)` was E0612. The smallest
form: `_Id :: (fn(comptime(V) : ?Sized) -> comptime(Type))(V)` gave
`_Id(&i32) == i32`.

## Root cause

A comptime type parameter's slot is a borrow, and a call argument written
`&x` at a borrow slot is a lend whose marker is peeled before evaluation
(`apply_call_site_borrow_markers`, `src/evaluator/calls/helper.yo`). The peel exempts
a parameter that takes a type ("the argument is a reference TYPE, not a lend",
decision 43 N2a), but tested that with `is_type_hierarchy_type`, which matches
the `Type` universe only. A `?Sized`-kinded parameter fell through, so `&_PgC`
was peeled to `_PgC`. The same `Type`-only test decided four other
"this parameter takes a type" questions in the call path (the expected-type
hint, the comptime flag, the reference-argument write check and the literal
fit check).

## Fix

`is_type_parameter_type` (`src/types/guards.yo`) is the `Type` universe or the
`?Sized` kind; the call-path sites that ask "does this parameter take a type"
use it (`src/evaluator/calls/helper.yo`, `src/evaluator/calls/function.yo`).

## Test

`tests/sized.test.yo`, "a reference type argument at a ?Sized parameter keeps
its reference": `_SzId(&i32)` is `&i32`, `Eq(&C)` is not `Eq(C)`, and a user
`impl(C, Eq(&D))` over a different reference `Rhs` type-checks with its
`& &D` method slots. `tests/impl_ref.test.yo`'s P3b gap 1 rows (#1933) are the
end-to-end check once develop is merged (24 passed on the merged scratch tree,
2026-11-14).

The first version of this test wrote the fix's proof as a user
`impl(&C, Eq(&C))`. Beside the prelude's blanket `impl(&T, Eq(&T))` (the g2
lane's piece 3) that shape is E0612 by coherence — the blanket covers `&T`
for every `T <: Eq(T)`, the where-clause cannot be refuted for a type with no
`Eq` impl of its own, so no manual impl of that shape can register (Rust's
`impl<T: PartialEq> PartialEq<&T> for &T` behaves the same). The row was
reshaped to `impl(C, Eq(&D))`, which no blanket covers, so it holds with and
without the blanket (measured on the s1 scratch tree = this branch + develop
57fb978f9 + vbd/g2-piece3, 2026-11-14).
