# A conditional `Clone` impl answers yes for a type argument without `Clone`

**Severity:** S2: `Type.impls(G(X), Clone)` is true for a generic `G` whose `Clone` impl requires `where(T <: Clone)`, even when `X` has no `Clone`. A derive or a generic body that trusts the answer reaches a `clone()` that does not exist.

> Found 2026-10-09 while deleting `MoveOnly` (decision 36 step 4,
> `plans/VALUES_BY_DEFAULT.md`): the rewritten `tests/move_only.test.yo`
> asserted that `Option(_MoFd)` (a `Dispose` payload) is neither `Copy` nor
> `Clone`, and the `Clone` half failed. Reproduces with the installed v0.2.54,
> so it predates decision 36's flip.

## Reproducer

```rust
_Plain :: struct(n : i32);
_W :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
derive(generic(T : Type), where(T <: Clone), _W(T), Clone);
_Tr :: trait(go : (fn(self : Self) -> i32));
_G :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), where(T <: Clone), _G(T), _Tr(go : (fn(self : Self) -> i32)(i32(1))));
_a :: comptime_assert(!Type.impls(_W(_Plain), Clone), "W clone");
_b :: comptime_assert(!Type.impls(_G(_Plain), _Tr), "G tr");
main :: (fn() -> unit)(());
export(main);
```

`_a` fails, and `_b` passes. Without a derive, the prelude's `Option` impl
(`impl(generic(T : Type), where(T <: Clone), Option(T), Clone(...))`) answers
the same way: `Type.impls(Option(_Plain), Clone)` is true.

So the `where(T <: Clone)` bound is enforced when the trait being implemented
is a user trait (`_Tr`), and not when it is `Clone` itself. `_Plain` alone
answers `Type.impls(_Plain, Clone) == false`, so the bound check sees a
different answer than the direct query, or is skipped for `Clone`.

## Root cause

`try_match_generic_impl` (src/evaluator/values/impl.yo) checks every
`where` entry, but in the trait-predicate mode it only REJECTED the impl when
the bound's trait was a marker (`_is_marker_trait`: no SomeT anywhere in its
members). The reason is real for a parametric bound: `where(T <: Eq(T))` is
stored as `Eq(SomeT(T))`, a trait built for the impl's own parameter, and even
`i32 <: Eq(SomeT(T))` answers false. But `Clone`'s members mention only
`Self`, the trait's own variable, so it was lumped in with `Eq(T)` and its
failed bound was ignored. The `_Tr` case "passed" for the same reason the
`Clone` one failed: neither bound was enforced, and `_G(_Plain) <: _Tr` was
false for an unrelated reason (the impl body did not register).

## Fix

`_where_trait_mentions_no_forall`: a bound whose trait mentions none of the
impl's forall SomeTs (by name and frame level) is instantiation-independent,
exactly like a marker, so the predicate enforces it. `Clone`, `Hash`, `Ord`
qualify; `Eq(T)` and `Iterator(Item := A)` still do not.

Tests: tests/copy_trait.test.yo "Clone: a conditional Clone impl answers no
for a type argument without Clone" (a derived, a hand-written and the
prelude's `Option` conditional `Clone`, with over-rejection canaries), and
tests/move_only.test.yo's `Option(_MoFd)` assertion has its `Clone` half back.
