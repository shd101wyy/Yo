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

## Next step

Trace `_find_matching_generic_impl` (`src/evaluator/trait_checking.yo`) for
`_W(_Plain) <: Clone`: whether the impl's `where` entries are checked, and
what `T <: Clone` answers there.
