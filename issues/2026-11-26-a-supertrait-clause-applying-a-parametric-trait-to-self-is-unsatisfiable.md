# A supertrait clause that applies a parametric trait to `Self` (`trait(where(Self <: A(Self)))`) is unsatisfiable: E0602 at every impl

**Severity:** S2 — a valid trait declaration cannot be implemented by any type, so Rust's `Eq : PartialEq<Self>` shape cannot be written; no workaround inside the clause.

**Found:** 2026-11-26, VERDICTS-87, probes `m1`, `m2`, `s1`.
**Measured:** `yo 0.2.79` built from develop (`~/Workspace/Yo-wt/v0280-p12/yo-out/x86_64-unknown-linux-gnu/bin/yo`), `--std-path` of develop `030d63040`.

## Symptom

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

A :: (fn(comptime(Rhs) : Type) -> comptime(Trait))(trait(same : (fn(lhs : &Self, rhs : &Rhs) -> bool)));
B :: trait(where(Self <: A(Self)));
P :: struct(x : i32);
impl(P, A(P)(same : (fn(lhs : &Self, rhs : &Self) -> bool)(lhs.x == rhs.x)));
impl(P, B());

main :: (fn() -> unit)({
  println("ok");
});
export(main);
```

```text
error[E0602]: Type "P" does not implement required constraint "(same : fn(lhs : &Self, rhs : &Self : (<trait:trait____m1_supertrait_param_self_A_r0c51_n1>)) -> bool)" from trait "B"'s where clause.
  --> ./m1-supertrait-param-self.yo:7:1
  |
7 | impl(P, B());
  | ^^^^
help: run `yo explain E0602` for more information
yo: error: check: 1 file(s) failed evaluator coverage
```

`P` does implement `A(P)`. The same failure with the prelude's own `Eq`:

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

B :: trait(where(Self <: Eq(Self)));
P :: struct(x : i32);
derive(P, Eq(P));
impl(P, B());
both :: (fn(generic(T : Type), a : &T, b : &T, where(T <: B)) -> bool)(a == b);

main :: (fn() -> unit)({
  p := P(x : i32(1));
  println(`${both(&p, &p)}`);
});
export(main);
```

```text
error[E0602]: Type "P" does not implement required constraint "(== : fn(lhs : &Self, rhs : &Self : (<trait:trait_std__prelude_Call_s2_r31c4_n66>)) -> bool, != : fn(lhs : &Self, rhs : &Self) -> bool)" from trait "B"'s where clause.
  --> ./m2-supertrait-eq-self.yo:6:1
  |
6 | impl(P, B());
  | ^^^^
help: run `yo explain E0602` for more information
yo: error: check: 1 file(s) failed evaluator coverage
```

Rust's four comparison traits written as user traits (`Eq : PartialEq<Self>`, probe `s1`) stop at this error.

## Root cause

The printed constraint shows `rhs : &Self : (<trait:…>)`: when the supertrait clause is checked at `impl(P, B())`, the `Self` inside the argument `A(Self)` is the unresolved trait-declaration `Self`, not the impl target `P`, so the required member signature never matches `P`'s `A(P)` impl. The clause `where(Self <: A)` with a non-parametric trait works. Root cause site not yet located in `src/evaluator/` (the impl-time where-clause check of a trait declaration).

## Test to add with the fix

In `tests/derive.test.yo` or a new section of `tests/where-clause-fn-inference.test.yo`: the `m1` program as a passing test (`impl(P, B())` accepted, and a `where(T <: B)` function using `A(T)`'s member), plus the `Eq(Self)` variant of `m2`. Both fail before the fix with E0602.
