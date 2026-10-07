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
