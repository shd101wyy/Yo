# A written instantiation dispatches to the first same-named impl, whatever its where-clause

**Severity:** S1 — wrong code, silently: when two inherent generic impls on one constructor pattern declare the same method under disjoint `where` bounds, `W(bool).mk(true)` runs the body of the impl whose bound `bool` does NOT satisfy.

**Status:** fixed on `feat/sai-a1-static-arg-inference` (static-argument inference A1). **Found:** 2026-10-27, while writing static-argument inference A1's where-clause tests (`feat/sai-a1-static-arg-inference`). The inferred form `W.mk(true)` selects by bound (A1 checks each candidate impl's where-clause, `first_failed_impl_where` in `src/evaluator/values/impl.yo`); the written form does not.

## Reproducer

```yo
{ assert } :: import("std/assert");
Quiet :: trait(id := "Quiet");
impl(bool, Quiet());
W :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T, tag : i32));
Loud :: trait(id := "Loud");
impl(i32, Loud());
impl(generic(T : Type), where(T <: Loud), W(T), mk : (fn(x : T) -> Self)(Self(v : x, tag : i32(1))));
impl(generic(T : Type), where(T <: Quiet), W(T), mk : (fn(x : T) -> Self)(Self(v : x, tag : i32(2))));
main :: (fn() -> unit)({
  a := W(i32).mk(i32(1));
  b := W(bool).mk(true);
  assert(a.tag == i32(1), "Loud");
  assert(b.tag == i32(2), "Quiet");
});
export(main);
```

Built with develop `476cfb700`, the binary aborts on the second assert (`b.tag` is 1: the `Loud` impl's body ran for `bool`, which is not `Loud`). No diagnostic is reported.

## Root cause

`find_methods_from_generic_impls` (`src/evaluator/values/impl.yo`) returns every generic impl whose receiver pattern matches and that declares the method, and the caller takes the first. `try_match_generic_impl` runs it with `enforce_all_where = false` on purpose: a constructed pattern's where-clause is not enforced at dispatch, because a load-order false negative of the trait predicate (`String <: Hash` while std loads) would delete a method that does exist. Both impls therefore matched `W(bool)`, and the first registered answered for both. In the `_Sel` shape the same happens across patterns: `_Sel(T)` with `T := Option(bool)` matches `_Sel(Option(bool))` as well as the `_Sel(Option(T))` impl it was written for (when a field mentions `T`; otherwise the second impl does not match at all, issues/2026-10-27-an-impl-on-a-compound-instantiation-of-a-phantom-parameter-never-matches.md).

## Fix

`_drop_where_failed_candidates`, after the candidate collection: when two or more candidates exist, those whose where-clause demonstrably fails drop out, provided one whose clauses hold remains. A clause is judged as `first_failed_impl_where` judges it for the inferred form: a marker bound, or a trait that mentions none of the impl's binders, the two kinds the stored trait value answers exactly. A lone candidate is kept as before, so the false-negative protection stands where it matters.

## Regression test

`tests/static_argument_inference.test.yo`, "the written form selects among same-named impls by where-clause too". On develop `476cfb700` the `_Pick(bool).mk(true)` assert fails, and `_Sel(Option(bool)).mk(true)` is E0601 "Cannot unify incompatible types: Expected Option(bool), Given bool".
