# Under `where(T <: (G1, G2))` with both traits declaring a method, the call is accepted and one impl is picked silently

**Severity:** S2 — an ambiguous call is accepted in a generic body and runs one impl chosen by impl registration order, not by the order the bounds are written; the same call on the concrete type is E0616.

**Found:** 2026-11-25, VERDICTS-85 (the `<:` bound-spelling consult), probes `d1b`–`d1f`.
**Measured:** `yo 0.2.79` built from develop (`~/Workspace/Yo-wt/v0280-p12/yo-out/x86_64-unknown-linux-gnu/bin/yo`), `--std-path` of develop `fc89e3195`.

## Symptom

```yo
{ println } :: import("std/fmt");

Circle :: struct(r : i32);
G1 :: trait(get : (fn(self : &Self) -> i32));
G2 :: trait(get : (fn(self : &Self) -> i32));
impl(Circle, G1(get : (fn(self : &Self) -> i32)(self.r)));
impl(Circle, G2(get : (fn(self : &Self) -> i32)(self.r + i32(100))));

pick :: (fn(generic(T : Type), x : &T, where(T <: (G2, G1))) -> i32)(x.get());

main :: (fn() -> unit)({
  c := Circle(r : i32(1));
  println(`${pick(&c)}`);
});
export(main);
```

`yo check` is rc=0 and the compiled program prints `1`: G1's impl, although `G2` is listed first. Swapping the bound to `(G1, G2)` also prints `1`. The static form behaves the same: `T.make(i32(1))` under `where(T <: (Make, Make2))` and under `where(T <: (Make2, Make))` both print `1` (Make's), probes `d1b` and `d1f`.

The same call with no bound, on the concrete type, is rejected:

```yo
{ println } :: import("std/fmt");

Circle :: struct(r : i32);
G1 :: trait(get : (fn(self : &Self) -> i32));
G2 :: trait(get : (fn(self : &Self) -> i32));
impl(Circle, G1(get : (fn(self : &Self) -> i32)(self.r)));
impl(Circle, G2(get : (fn(self : &Self) -> i32)(self.r + i32(100))));

main :: (fn() -> unit)({
  c := Circle(r : i32(1));
  println(`${c.get()}`);
});
export(main);
```

```text
error[E0616]: The call to "get" is ambiguous: impl(Circle, G1) (get : fn(self : &Self)) and impl(Circle, G2) (get : fn(self : &Self)) both take the receiver as &Circle, and nothing says which one is meant.
Name the trait: (Circle <: G1).get(c, ...) or (Circle <: G2).get(c, ...), or call it where a where(T <: Trait) bound selects one.
   --> m2.yo:11:15
   |
11 |   println(`${c.get()}`);
   |               ^
help: run `yo explain E0616` for more information
```

The E0616 hint says a `where(T <: Trait)` bound selects one. That holds for a bound naming one of the traits. A bound naming both selects none, and nothing reports it.

## Root cause

`_select_matching_overload` in `src/evaluator/calls/function.yo` applies the where-constraint preference before the ambiguity rule. It reads the enclosing specialization's active bound trait ids (`active_where_trait_ids()`, `src/expr-info.yo`) and, when several matching candidates come from different traits, walks the candidates in the order they were registered (`matching`, the outer loop) and takes the first whose `source_trait_id` is in the active set. It stops there and sets `aw_chosen`. The rule was written for one bound selecting between same-signature impls (`DisambigPoint`, `impl.test.yo`), where "the first match in the set" is the only match in the set. With two traits that both declare the method, both candidates are in the set, so the winner is the earlier-registered impl, the bound's written order is never consulted, and `aw_chosen` then skips the E0616 block (`amb_traits.len() > 1`) that the concrete call reaches.

`issues/fixed/a-method-call-two-trait-impls-supply-silently-picks-one.md` fixed the concrete case and documents the where preference as a tie-breaker, with no case for two bound traits supplying the same name. `issues/retired/the-wrapper-payload-clash-is-not-reported-inside-a-generic-body.md` is a different clash.

## Fix direction

In the where-preference block, count the distinct active traits among the matching candidates. When more than one supplies the call, do not set `aw_chosen`; let the E0616 block report it, naming the bound's traits and the qualified repair `(T <: G1).get(x, ...)`. A bound naming one of the traits keeps selecting it.

## Test to add with the fix

`tests/dyn.test.yo` (beside "an unqualified call two trait impls supply is ambiguous (E0616)"): a `comptime_expect_error` for a generic body `x.get()` under `where(T <: (G1, G2))` and for the static form `T.make(...)` under `where(T <: (Make, Make2))`, each expecting E0616; plus a positive case that `where(T <: G2)` alone, and the qualified `(T <: G2).get(x)` under the two-trait bound, still select G2's impl.
