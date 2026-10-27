# A written instantiation dispatches to the first same-named impl, whatever its where-clause

**Severity:** S2 — wrong code, silently: when two inherent generic impls on one constructor pattern declare the same method under disjoint `where` bounds, `W(bool).mk(true)` runs the body of the impl whose bound `bool` does NOT satisfy.

**Status:** open. **Found:** 2026-10-27, while writing static-argument inference A1's where-clause tests (`feat/sai-a1-static-arg-inference`). The inferred form `W.mk(true)` selects by bound (A1 checks each candidate impl's where-clause, `first_failed_impl_where` in `src/evaluator/values/impl.yo`); the written form does not.

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

## Root cause (not instrumented)

`try_match_generic_impl` rejects an impl whose where-clause fails, so the miss is upstream of it. The likely place is the per-instantiation method table: the first impl to give `W(...)` a method named `mk` wins, and the second impl's `mk` is never consulted for that name.

## Fix direction

When several generic impls on one pattern declare the method, the written-form lookup should keep the candidates whose where-clauses hold, the same way the inferred form does. Zero candidates is E0602 naming the failed bound, and two is the ambiguity error. The regression test is the reproducer as a `tests/` case, with both asserts.
