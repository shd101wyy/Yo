# An associated-type binding to a reference type is read as a local borrow: `Iterator(Item := &A)` is "Expected identifier for associated type label"

**Severity:** S3 — a correct bound is rejected; the type-function spelling `Item := _RefTo(A)` (`_RefTo :: (fn(comptime(A) : Type) -> comptime(Type))(&A)`) is the workaround `std/prelude.yo`'s `Iterator.cloned()` / `copied()` use.

Filed 2026-11-28 by the `v81-s3` lane while adding `Iterator.cloned()` and `copied()` (STD_RUST_ALIGNMENT §3.5), on the installed v0.2.80 seed with the tree std.

## Reproducer

`issues/repros/2026-11-28-an-associated-type-binding-to-a-reference-type-is-read-as-a-local-borrow.yo`:

```yo
{ ArrayList } :: import("std/collections/array-list");
first_of :: (fn(generic(A : Type), forall(I : Type), sink(it) : I, where(I <: Iterator(Item := &A), A <: Copy)) -> Option(A))({
  mut(i) := it;
  match(i.next(), .Some(r) => .Some(r.*), .None => .None)
});
main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(7));
  x := first_of(xs.iter());
  assert(x.unwrap() == i32(7), "first");
});
export(main);
```

```text
error: Expected identifier for associated type label, got:
__yo_imm(Item)
  --> tmp/r1/assoc.yo:2:96
```

`Item := (&A)` gives the same error.

## Root cause

The decision-42 slot rewrite in `src/expr.yo` (the `_BorrowSigil` block, `y := &place` → `__yo_imm(y) := place`)
fires on every `:=` whose right side is a borrow sigil, including an associated-type binding inside a trait
application's arguments. `Iterator(Item := &A)` reaches `src/evaluator/calls/trait-type.yo` as
`Iterator(__yo_imm(Item) := A)`, whose label is not an atom.

## Fix

Leave a `:=` inside the arguments of a type-level call (a trait application in a bound) unrewritten, so `&A` is read as
the reference type, as it is for `T :: &i32` and `ArrayList(&T)`. A test: the reproducer as a `tests/` case, and the
prelude's `_RefTo` replaced by `&A` once the seed carries the fix.
