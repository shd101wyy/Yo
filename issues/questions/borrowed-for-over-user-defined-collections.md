# Can a user-defined container opt into the borrowed `for`? (OPEN-DESIGN)

**Kind:** design question — an open decision, not a defect. Filed 2026-10-10
from the `plans/backlog/RUST_REFERENCE_PATTERNS.md` audit (§5.3).

## The hole

Decision 39 (amended) makes read-only walks over a value container the
**borrowed `for`** — `for(xs, mut(x) => …)` — "over the container place
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
2. **A `Collection` trait** (Swift's shape): `len(imm(self)) -> usize` and
   `Index` with `imm`/`mut` projections. The borrowed `for` desugars to a
   cursor loop over `0..c.len()` with `c(i)` re-derived per step, for any
   type implementing it; growth mid-walk is the same out-of-bounds error.
   `ArrayList` and the rest implement it, so std and user types share one
   spelling and one lowering (CP2b hoists for every implementor).
3. **Borrow-mode struct fields** (decision 39's "recorded for later"): a
   true borrowing iterator type. Larger, and tied to decision 37's trigger.

## Recommendation

Option 2, with V2b (the same PR that gives the borrowed `for` its final
shape over std). It is one trait, no new mechanism, and it is what makes
"a borrow is a mode, not a type" hold for user containers too: the
container is the lent place, the index is `Copy`, and `for` is a loop
the user could have written. `HashMap`'s walk is over its bucket indices
with a skip for empty slots, which the trait expresses as
`next_index(i) -> Option(usize)` if a plain `0..len` is not dense enough —
decide that detail when `HashMap` implements it. Option 3 stays parked on
decision 39's trigger.
