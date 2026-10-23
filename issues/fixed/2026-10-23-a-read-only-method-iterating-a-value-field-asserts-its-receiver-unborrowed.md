# A read-only method iterating a value field asserts its receiver unborrowed

**Severity:** S2 — a valid program panics. A `self : &Self` method on a `ref`
object that only reads a value-typed field with `for(self.field, x => …)` is
given the borrowed `for`'s entry invalidation assert
(`__yo_borrow_assert_unborrowed(self)`), as if it mutated the object. Calling
it through a second handle while a borrowed `for(&mut obj, …)` holds the
object's flag panics with "container operation while an interior reference
… borrows from it".

**Status:** fixed (branch `fix/c7-readonly-iter-receiver`). **Found:** 2026-10-23 by the V2b B8 flip probe
(`plans/handover/VBD_B8_PROBE_CENSUS_2026-10-22.md`). Once `ArrayList` is a
value, `tests/for_macro_borrow_user_collection.test.yo`'s "user methods
iterating the collection or mutating a fresh copy, through an alias, do not
trip the flag" fails this way: `Bag.sum_by_value_for` runs
`for(self.items, …)` over the value list. The bug does not need the flip. The
repro below uses develop's std (`e30c0d8ed`) and a user value collection. The
v0.2.68 seed and a develop-built binary behave the same.

## Reproducer

`issues/repros/2026-10-23-a-read-only-method-iterating-a-value-field-asserts-its-receiver-unborrowed.yo`:

- `VL` is a `Clone` value struct.
- Its `IntoIterator.into_iter(self : &Self)` returns a `VLIter` that holds
  `self.clone()`.
- `Bag :: ref(struct(items : ArrayList(i32), vl : VL))` implements
  `BorrowedWalk` over `items`.
- `Bag.total_vl(self : &Self)` sums `for(self.vl, x => …)`.
- `main` runs `for(&mut bag, x => { seen = (seen + other.total_vl()); })`,
  where `other := bag` is a second handle.

```text
panic: container operation while an interior reference (a 'ref' into an element/field) borrows from it
```

The expected output is `3`.

What changes the outcome (all with develop's std):

| `VLIter`'s source field | `total_vl` gets the entry assert | Result |
| --- | --- | --- |
| `src : self.clone()` (the repro) | yes | panic |
| `src : VL(n : self.n)` (a fresh literal) | no | `3` |
| `n : self.n` (no copy of the collection) | no | `3` |

The assert sits in `total_vl` itself, the first statement of its C body.

## Root cause

The hypothesis filed with this doc was wrong: the clone does not taint the
iterator with the receiver's storage. Nothing was ever rooted at parameter
storage. Two defects in the PARAM-STORAGE analysis
(`src/evaluator/effects/mutation_summary.yo`) combined.

1. **A runtime construction read as a folded constant.** The evaluator gives a
   runtime struct, enum, tuple or array construction an `ExprInfo.value` that
   is a `StructVal`/`EnumVal`/`TupleVal`/`ArrayVal` SHELL with an
   `UnknownVal` leaf (`begin.yo` already relied on that shape). The analysis
   treated every value that was not exactly `UnknownVal` as "compile-time
   known, inlined by codegen, roots nothing". So the derived
   `Clone.clone` (`Self(n : self.n.clone())`) and a hand-written one with a
   bare constructor tail analyzed to a NONE result, and `into_iter`'s tail
   `VLIter(src : self.clone(), i : 0)` classified NONE. The same gate sat in
   seven places: the mutation walk, the atom root, `classify`, the flow
   walk, `collect`, the strict-borrow walk and the mask walk.
2. **A local defined with a NONE root read back as undefined.** `_msp_def`
   recorded a name only when the join changed, and joining NONE into an
   absent entry changes nothing. So `for_iter_var0 := self.vl.into_iter()`
   never entered the root table, and `_msp_atom_root` read the missing
   local as "never defined in this body", which is ROOTED (unknown storage).
   `next(&mut for_iter_var0)` writes its parameter, so the write landed on
   unknown storage, the mask became `all`, and codegen emitted
   `__yo_borrow_assert_unborrowed(self)` at `total_vl`'s entry.

Defect 2 alone explains a fully constant iterator
(`VLIter(src : VL(n : 3), i : 0)`), a correctly classified NONE that still
asserted. Defect 1 had a soundness twin, a missed assert that let a borrowed
`for` read freed memory:
`issues/fixed/2026-10-23-a-mutating-call-inside-a-constructor-argument-escapes-the-borrow-assert.md`.

## Fix

- `value_contains_unknown` (`src/value.yo`, moved from `begin.yo`'s private
  `_value_contains_unknown` and extended to tuples and arrays) is true for a
  value with an unknown leaf anywhere. All seven gates in
  `mutation_summary.yo` now treat a value as folded only when it has no
  unknown leaf. A runtime construction is classified by its arguments
  (`ctor_root`), so a clone's result is FRESH and an iterator holding it is
  FRESH. `UnitVal` and `FuncVal` keep their old treatment.
- `define_from` records a declared local even when its root is NONE, so a
  defined-but-inert local is no longer read as undefined. A pointer-typed
  local whose root is NONE (fabricated from integers) still reads as
  unknown storage, matching `ctor_root`'s rule.
- No `Clone` special case: a clone is not always fresh (`Rc.clone` shares
  its payload), and the callee analysis already models that.

Regression test: `tests/for_macro_borrow_user_collection.test.yo`, "borrowed
for: read-only methods iterating a value field by value, through an alias,
do not trip the flag". It covers a derived `Clone`, a hand-written `Clone`
with a bare constructor tail, a `Copy` source, an iterator bound to a local
then returned, a fully constant iterator and a chain of locals. Before the
fix, five of the six methods carried the entry assert and the test panicked
(the chain of locals did not). The existing
"user methods iterating the collection…" test is unchanged.

## Why it matters for the release plan

After B8, every `ArrayList` iterator that owns a clone of its list (the probe's
stand-in for B7's iterator shapes) puts an entry assert on read-only methods
of `ref` objects that iterate a list field. B7's borrowing iterators would
avoid the clone. Until then the probe cannot tell this bug from a real
invalidation.
