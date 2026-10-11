# Should `Index` take its index by value and `self` read-only, as Rust's does? (RETIRED)

**Kind:** design question: an open decision, not a defect. Filed 2026-10-11
while making effect records by-value (`exn : Exception`, #1312).

**Verdict (2026-10-11):** the recommendation was taken, in its stated order.
The by-value index landed the same day — `Index`'s `idx` is `Idx` by value,
the std and test impls were respelled, and the dispatch path learned the
normal by-value argument rule (`consume_argument_for_parameter` in
`try_to_call_with_index_trait`), without which an RC-typed index's count
underflowed at the synthesized dispatch call. The `Index`/`IndexMut` split
waits for decision 24 (V2b) with the projection result, as recommended.
Retired to `issues/retired/` (resolved by landing, not by a targeted fix).

## The question

The prelude's `Index` trait is:

```yo ignore
Index :: (fn(comptime(Idx) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    index : (fn(self : &mut Self, idx : &Idx) -> *Self.Output)
  )
);
```

Rust's is `fn index(&self, index: Idx) -> &Self::Output`, plus a separate
`IndexMut` with `&mut self`. Yo's version differs in two ways:

- **`idx : &Idx` borrows the index.** Every index in the tree is a `Copy`
  scalar (`usize`, `i32`) or a `str`, so the borrow only adds an
  indirection. It also forces impls to write `idx : &usize`
  (`std/encoding/json.yo`), which is exactly the `&Copy` spelling #1312
  removed for effect records. Decision 34 (as amended 2026-10-11) already
  makes the arithmetic operator traits take their operands by value, as in
  Rust.
- **`self : &mut Self` for a read.** The result is a raw `*Self.Output`
  projection that both reads and writes go through, so one exclusive mode
  covers both. Rust splits these into `Index` (`&self`) and `IndexMut`
  (`&mut self`), so a read through a shared borrow type-checks.

## Recommendation

- Take the index by value: `idx : Idx`. This matches Rust and decision 34's
  by-value rule. Every existing `Idx` is `Copy` or `str`, so no call site
  changes; only the impls' signatures do. A heavy index type can still be
  borrowed by instantiating `Idx` with a reference type once decision 43
  makes `&T` a type.
- Split the trait into `Index` (`self : &Self`, a read-only projection) and
  `IndexMut` (`self : &mut Self`). Do this with decision 24's projection
  results (`-> &T` / `-> &mut T`), not before: the split is only meaningful
  once the result is a borrow instead of a raw pointer.
- Order: the by-value index can land alone at any time. The split lands
  with decision 24.
