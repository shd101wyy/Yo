# Can a user-defined container opt into the borrowed `for`? (OPEN-DESIGN)

**Kind:** design question (decided; retired into the plan).

**Status:** DECIDED 2026-10-18. #1429 (decision 39 Generation A) landed a `BorrowedWalk` trait, and the maintainer delegated the open VBD questions to the coordinator's advisor and accepted its verdicts. Filed 2026-10-10
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

## Update 2026-10-17: Generation A ships option 2 as a cursor protocol

Decision 39's Generation A (the "shape, settled 2026-10-17" bullet in
`plans/VALUES_BY_DEFAULT.md`) lowers `for(&mut xs, x => …)` to a cursor
walk over a local borrow `c := &mut xs`, through the prelude trait
`BorrowedWalk`:

```yo ignore
BorrowedWalk :: trait(
  WalkCursor : Type,
  WalkElem : Type,
  walk_start : (fn(self : &Self) -> Self.WalkCursor),
  walk_valid : (fn(self : &Self, cur : &Self.WalkCursor) -> bool),
  walk_elem : (fn(self : &mut Self, cur : &Self.WalkCursor) -> &mut Self.WalkElem),
  walk_next : (fn(self : &Self, cur : &Self.WalkCursor) -> Self.WalkCursor)
);
```

This is option 2, with the index generalized to a cursor so that maps
(a bucket index) and `LinkedList` (a node) fit too. Any type that
implements it is a borrowed-`for` source, so std and user types share one
spelling and one lowering.

**The gap that remains.** A user type cannot implement `walk_elem` in safe
code yet. Its body must yield the element's place, and the only way a
user container can name that place is through its inner collection's
projection, `self.items.walk_elem(cur)`. A projection body that returns
another projection rooted at `self` is a type error today ("Cannot unify
incompatible types: "i32" and "*(i32)""). So a user collection needs
`pragma(Pragma.AllowUnsafe)` and a raw pointer (`self.items.ptr()`), as
`tests/for_macro_borrow.test.yo`'s `Bag` does. Before this change, any type
with a pointer-yielding `iter()` was a source. That `iter()` is headed under
the same pragma (decision 39), so the requirement is the same either way.

**Correction (2026-10-18).** The gap is narrower than the paragraph above says. The quoted error comes from the bare tail `self.items.walk_elem(cur)`. With the call-site marker, `&mut self.items.walk_elem(cur)` or `&mut self.items(cur)`, a plain-value collection already forwards the projection in safe code. Only a `ref(...)` collection still needs the pragma; see the Verdict.

**Recommendation for the gap:** let a projection body forward a projection
whose root is `self` or one of its own `&`/`&mut` parameters (decision 24's
result positions, the single-root rule `NON_ESCAPABLE_TYPES.md` R3 states
for decision 43's phase). That lowers to returning the inner call's pointer
instead of dereferencing it. It is a small compiler Generation A and does
not wait for reference types. Until it lands, user collections implement
`BorrowedWalk` under the pragma. Decision 43's
`impl(&C, IntoIterator(…))` remains the final shape.

## Verdict

- **`BorrowedWalk` is the pre-decision-43 shape and stands.** It came with #1429; its methods are `walk_start`, `walk_valid`, `walk_elem` (which returns a `&mut` element) and `walk_next`. A user collection implements it to get the borrowed `for`.
- **Decision 43 step 3 decides what comes next** (root-joining, N2). If `impl(&mut C, IntoIterator(…))` replaces `BorrowedWalk` there, the implementors migrate and the trait is deleted. If it does not, `BorrowedWalk` stays as the "Collection trait" fallback that option 2 above describes.
- **A plain-value user collection implements `walk_elem` in safe code.** Checked on 2026-10-18 with a develop-built compiler:
  - Forwarding the inner projection with its marker works: `&mut self.items(cur)` or `&mut self.items.walk_elem(cur)`.
  - The "type error" described above is the bare form `self.items.walk_elem(cur)`, without `&mut`. It was a misleading E0601 (fixed 2026-10-18: the decision-24 message now names the lending spelling), `issues/fixed/2026-10-18-a-bare-projection-call-as-a-projection-body-is-a-misleading-e0601.md` (S3).
  - A `ref(...)` collection forwards the projection in safe code too (fixed 2026-10-18): the mutation mask now reads a projection tail as a lend of its receiver, so `walk_elem` carries no false entry invalidation assert and the borrowed `for`'s guard does not trip it — `issues/fixed/2026-10-18-a-projection-forwarded-through-a-ref-receiver-leaves-its-borrow-flag-set.md` (S2).
- **`HashSet` and `PriorityQueue` refuse `for(&mut …)` by design.** A `&mut` element would let a caller corrupt their hashing or ordering. If a read-only walk that yields `&T` is added (V2b B7), they implement it; until then their element walk is the consuming `into_iter`.
- **Reading the collection inside a borrowed `for` body is E0911, by design.** `&mut coll` is live for the whole call, so a read through another path is the exclusivity rule. The E0911 help points to `coll.indices()`.
- **A borrow declared in a macro's template is live for the whole macro call** when the macro comes from another file. Its tokens have no position in the caller's file, so token-based liveness cannot apply. A same-file macro keeps token-based liveness, because there the positions compare.
