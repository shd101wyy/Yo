# A read-only method iterating a value field asserts its receiver unborrowed

**Severity:** S2 — a valid program panics. A `self : &Self` method on a `ref`
object that only reads a value-typed field with `for(self.field, x => …)` is
given the borrowed `for`'s entry invalidation assert
(`__yo_borrow_assert_unborrowed(self)`), as if it mutated the object. Calling
it through a second handle while a borrowed `for(&mut obj, …)` holds the
object's flag panics with "container operation while an interior reference
… borrows from it".

**Status:** open. **Found:** 2026-10-23 by the V2b B8 flip probe
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

## Root cause (hypothesis)

The PARAM-STORAGE mutation mask (`function_param_mutation_mask`,
`src/evaluator/effects/mutation_summary.yo`) taints the iterator local
with the receiver's storage, because the iterator was built from
`Clone.clone(&self.vl)`. Then `Iterator.next(&mut iter)` writes the
iterator's cursor, and the mask reads that write as a mutation of
storage reachable from `self`. The clone's result is not treated as fresh storage,
even though a by-value clone shares nothing with its source. The fresh
literal in the table's second row is treated as fresh, which is consistent
with this hypothesis. The probe did not trace the mask; this is the reading
of the three rows, not a confirmed diagnosis.

## Fix direction

The result of a `Clone.clone` call (and of any call returning a value type
by value that holds no `ref`/`Rc` handle) is storage of the caller's own.
Writes to it, and to a value that contains it, do not reach the argument's
storage. The regression test is the repro, which should print `3`.

## Why it matters for the release plan

After B8, every `ArrayList` iterator that owns a clone of its list (the probe's
stand-in for B7's iterator shapes) puts an entry assert on read-only methods
of `ref` objects that iterate a list field. B7's borrowing iterators would
avoid the clone. Until then the probe cannot tell this bug from a real
invalidation.
