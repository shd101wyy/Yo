# Collection iterators have no sound post-V2b shape; decision 39 makes them index-based

**Severity:** S2

Filed 2026-10-07 from the soundness audit in
[issue #1251](https://github.com/shd101wyy/Yo/issues/1251) (finding 2).
The design is DECIDED — decision 39 in
`plans/VALUES_BY_DEFAULT.md`, confirmed by the maintainer 2026-10-07 —
and this doc tracks the V2b implementation requirement plus the V3b sweep
exemption that must land first.

**Amended 2026-10-07 (second audit #1264, finding 4, confirmed by the
maintainer):** the "handle + index" iterator the first text of decision 39
described has no spelling under decision 38 A (a borrow cannot be a struct
field, a second-class value cannot be returned, and only closures and
futures hold borrows). Decision 39 now says the iterator holds NO handle:
read-only walks are the borrowed `for` over the container place, index
cursors are `xs.indices()` (a `Range(usize)`) with `xs(i)` re-derived,
`into_iter()` consumes, `Rc(C).iter()` iterates a shared container, and
`iter()` on a value container leaves the safe surface. Step 2 below
re-derives the signatures from THAT text; the step 3 test applies to the
borrowed `for` and to an `indices()` walk.

## Why neither remaining spelling works after V2b

Today `ArrayList.iter()` takes `self` by value, stores the receiver in
the iterator (`ArrayListIterPtr(T)._list`), and yields `*(T)` into the
list's own buffer (`std/collections/array_list.yo`). It is sound only
because the stored handle is an RC dup — the count keeps the buffer
alive, and growth mid-walk is documented UB-by-discipline.

After V2b the buffer is uniquely owned and uncounted:

- **`self` by value** (today's signature): `xs.iter()` *moves* `xs`.
  Sound, but every read-only walk consumes the list, and every later use
  of `xs` is E0901.
- **`imm(self)`** (where the V3b migration table's mechanical rule would
  send it): cannot exist. A pointer-yielding iterator is a stored,
  returned, first-class value, and borrows are second-class (decision
  38 A) — the escape check rejects it loudly, but that means the sweep
  produces a build break, not a working iterator.

The old plan text ("V2b needs an `iter_mut(mut(self))` split") addressed
mutation *through* the iterator, not the iterator's own validity.

## The decision (decision 39, 2026-10-07)

- `iter()` and every safe read-only iterator become **index-based**:
  an index cursor with no handle to the container (amended 2026-10-07,
  see above), re-derive `xs(i)` at each step; growth mid-walk is an
  out-of-bounds error, not UB. `into_iter()` keeps consuming.
- Pointer-yielding iterators stay only beside `ptr()` inside
  `pragma(Pragma.AllowUnsafe)` std files (the `HashMapIterPtr` shape).
- The V3b `yo fix` sweep **exempts iterator-returning methods** from the
  mechanical `imm(x)` conversion; §7's migration table carries the row.

## What must land, in order

1. The V3b sweep exemption (so the mechanical rename cannot produce the
   broken spelling), with the §7 table row.
2. V2b's PR re-derives `iter()` signatures per decision 39, with the
   iterator-heavy std tests measured before and after (one bounds check
   per step is the expected cost; hot loops keep `ptr()` under the
   pragma).
3. A test that growing a list mid-walk through the new `iter()` raises
   the out-of-bounds error instead of reading a stale buffer.

## Status 2026-10-17: the shape is settled; Generation A landed, Generation B closes this

The design is written out in `plans/VALUES_BY_DEFAULT.md`, decision 39,
"the shape, settled 2026-10-17". Where each step of "What must land" stands:

1. **The V3b sweep exemption: done.** §7's migration table carries the row
   ("an iterator-returning method's `self` … NOT converted by the sweep").
2. **The signatures: half done.**
   - Landed in Generation A:
     - the borrowed `for(&mut xs, …)` no longer goes through `iter()`. It
       walks a cursor (`BorrowedWalk`) over a local borrow `c := &mut xs`,
       so it stores no copy of the collection;
     - `indices()` on `ArrayList` and `Deque` is decision 39's index cursor;
     - a body that names the collection is E0911, which needed the
       macro-boundary fix
       `issues/fixed/2026-10-17-a-local-borrow-a-macro-expansion-declares-is-never-live-in-the-callers-code.md`.
   - Still open, and the reason this doc stays open: `iter()` and
     `into_iter(self : &Self)` still store the receiver
     (`ArrayListIter._list`, `ArrayListIterPtr._list` and the other
     collections' equivalents). Generation B (V2b B7, after B6):
     - the read walk for `for(&xs, …)`: **landed as B7a (2026-10-23)**, a
       `BorrowedWalk.walk_ref` cursor over `c := &xs` in every std
       collection (`tests/for_read_walk.test.yo`);
     - the `HashMapEntry` with-shape (decision 22): **landed as B7c
       (2026-10-25)** — `entry(key, body)` lends the entry to a body, holds
       the map as `*HashMap` (not a handle copy), `and_modify` returns
       `unit`, and a vacant `or_insert` flips the entry's slot so the body
       may keep using it; the `FnOnce` body spelling landed 2026-10-28
       (`issues/fixed/2026-10-25-a-generic-fnonce-parameter-cannot-be-called.md`),
       and `or_insert`/`or_insert_with` returning `&mut V` on
       `issues/2026-10-25-a-borrow-returning-generic-method-breaks-its-own-typed-parameters.md`;
     - a consuming `into_iter(self : Self)`;
     - `iter()` and the `*Ptr` iterators under
       `pragma(Pragma.AllowUnsafe)`.
3. **The growth test: done for the two forms that exist.**
   - `tests/for_macro_borrow.test.yo`, "indices(): a walk that grows its
     list reads the re-derived buffer", grows an `ArrayList` and a `Deque`
     past their first buffer during an `indices()` walk and reads every
     element from the new one.
   - Growth during a borrowed `for` is now rejected statically through the
     same variable (`push_on_the_borrowed_collection`), and panics through
     another handle (`tests/cli-cases/inout-for-alias-push-panics`).
   - A step past a shrink is the bounds panic: `walk_elem` and `xs(i)`
     check the live length.
   - What is left is the same test against the new `iter()`, which
     Generation B replaces with the walks above.

## Status 2026-10-25: B7b landed the consuming iterators

- `IntoIterator.into_iter` takes `self : Self` (`std/prelude.yo`), and so do
  its impls on every std collection, `String` and `Array(T, N)`, and the
  receiver-holding iterators `chars`, `bytes`, `char_indices`, `lines`,
  `keys`, `values`, `chunks` and `windows`. The iterator owns what it walks;
  while a collection is `ref`, the by-value receiver is a share, and the
  iterators still copy their elements out until each flip (lookahead D21).
  `tests/iterator_combinators.test.yo` ("B7b: …") pins a move-only source
  moving into its iterator and being dropped once.
- The seven `*Ptr` iterators hold the buffer pointer and the length that
  `iter()` saw, not the container, so `iter()` stores no copy of its
  receiver. They are raw views for `pragma(Pragma.AllowUnsafe)` code.
- What keeps this doc open: B7c, `HashMapEntry`'s `with` shape (it still
  holds the map).
