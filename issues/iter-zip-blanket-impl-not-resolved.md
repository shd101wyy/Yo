# IterZip blanket impl not resolved by trait method dispatch

## Status

**Fixed** in `src/evaluator/values/impl.ts` — `whereConstraintTraitExprById` map
was keyed by `traitType.id`, but specialized variants of the same trait
(e.g., `Iterator(Item := A)` and `Iterator(Item := B)`) share the base
trait's id. The second constraint's expression overwrote the first, causing
both where-clauses to re-evaluate against the wrong source expression.

Fix: key by `(someType.id, "req"|"neg", absolute index in constraint array)`
instead of `traitType.id`. Regression tests added to
`tests/iterator_combinators.test.yo` (`iter.zip pairs two iterators`,
`iter.zip stops at shorter iterator`).

## Symptom (historical)

Calling `.next()` (or `(&it).next()`) on an `IterZip(I, J)` value fails with:

```
Error: No matching call found with arguments:
(it.next)()
```

even though `IterZip` has an explicit `Iterator` impl in `std/prelude.yo`
(line ~6014).

## Reproducer

```rust
it := my_range(i32(0), i32(3)).zip(my_range(i32(100), i32(200)));
match(it.next(),
  .Some(p) => ...,
  .None    => ...
);
```

## Comparison

The `IterMap`, `IterFilter`, `IterTake`, `IterSkip`, `IterEnumerate` impls
all have the same shape (forall over inner type + `where(I <: Iterator(Item
:= A))`) and dispatch fine. The difference for `IterZip` is the where
clause has TWO constraints:

```
where(I <: Iterator(Item := A), J <: Iterator(Item := B))
```

This may be tripping up impl resolution / type synthesis when binding `B`
from the second iterator's Item.

## Suggested investigation

- Check `findMethodsFromGenericImpls` / `extractTraitTypeArgsFromImplExpr`
  in the evaluator: do they process two independent where-clause
  constraints correctly?
- Add a minimal repro: define a similar two-constraint impl outside of
  prelude and see if `.next()` resolves.
