# Can a user-defined container opt into the borrowed `for`? (OPEN-DESIGN)

**Kind:** design question — an open decision, not a defect. Filed 2026-10-10
from the `plans/backlog/RUST_REFERENCE_PATTERNS.md` audit (§5.3).

## The hole

Decision 39 (amended) makes read-only walks over a value container the
**borrowed `for`** — `for(&mut xs, x => …)` — "over the container place
(§3.10): the body is a non-escaping closure, each element is re-derived per
step through the place, and no iterator value exists". The text is written
for `ArrayList`/`HashMap`/`String`. It does not say whether a user type
can be the source of that `for`:

- Rust spells it `impl<'a> IntoIterator for &'a MyColl` (and `&'a mut`);
  Yo cannot, because the yielded item would be a borrow inside
  `Option(...)` (decision 38 A) — the same rule that removed the pointer
  iterators;
- Rust's `LendingIterator` (`next(&mut self) -> Option<&mut T>`) is the
  same shape and is ruled out for the same reason;
- a user container today can offer `indices() -> Range(usize)` plus an
  `Index` projection (decision 24), and callers write the cursor loop
  — Swift's model, but without Swift's `Collection` protocol that makes
  `for` work on anything indexable.

Without a decision, every user container (a ring buffer, a small-vector,
a sparse set, the compiler's `SmallVec`-shaped types) is iterated by a
visibly different spelling from std's, and the borrowed `for`'s hoisted
lowering (`CODEGEN_PERFORMANCE.md` CP2b) applies to std only.

## Options

1. **std only.** The borrowed `for` is a macro over the std containers;
   user types expose `indices()` + `Index` and `for_each(body)`.
2. **A `Collection` trait** (Swift's shape): `len(self : &Self) -> usize` and
   `Index` with `imm`/`mut` projections. The borrowed `for` desugars to a
   cursor loop over `0..c.len()` with `c(i)` re-derived per step, for any
   type implementing it; growth mid-walk is the same out-of-bounds error.
   `ArrayList` and the rest implement it, so std and user types share one
   spelling and one lowering (CP2b hoists for every implementor).
3. **Borrow-mode struct fields** (decision 39's "recorded for later"): a
   true borrowing iterator type. Larger, and tied to decision 37's trigger.

## Recommendation

**Answered by decision 43 (2026-10-10): Rust's exact shape.**
`impl(&C, IntoIterator(Item := &T, …))` and `impl(&mut C, IntoIterator(…))`
are legal once `&C` is a type, the borrowed `for(&xs, …)` dispatches to
them, and the iterator they return is a second-class value rooted in `xs`
(`NON_ESCAPABLE_TYPES.md` R3, R4). Option 2's `Collection` trait remains
available as a fallback for a container that only wants a plain index
walk. Lands with the design note's phase N2.
