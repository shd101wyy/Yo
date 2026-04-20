# IterZip blanket impl not resolved by trait method dispatch

## Symptom

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
