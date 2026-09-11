# `HashSet(T)` registers `FromIterator` TWICE — two byte-identical impl blocks in one file

**Status:** OPEN
**Severity:** papercut / latent — the duplicate is silently accepted today
(first-wins), so nothing misbehaves; it is exactly the shape
`plans/backlog/DUPLICATE_INHERENT_METHOD_REJECTION.md` wants rejected, and the
second copy is a place for the two to drift apart.
**Found:** 2026-09-11, during the `///` documentation sweep of
`std/collections/hash_set.yo`.

`std/collections/hash_set.yo` declares `impl(..., HashSet(T), FromIterator(...))`
twice, with identical bodies:

```
$ grep -n "FromIterator" std/collections/hash_set.yo
423:  FromIterator(
500:  FromIterator(
```

* the first (line ~419) has no doc comment;
* the second (line ~496) carries the doc comment
  `/// Build a `HashSet(T)` from any iterator of `T` — the target of
  `it.collect(HashSet(T))`. Duplicates collapse, as with `insert`.` and sits
  after the `hash_set!` literal macro and its own `export(hash_set);`.

Both spell `from_iter_new` as `HashSet(T).new()` and `from_iter_add` as
`acc.insert(item); acc`, so `xs.collect(HashSet(i32))` works and no test can
tell which registration served it.

Most likely provenance: the D16 rewrite (`HashSet` re-based on
`HashMap(T, unit)`, 962 lines → 452) landed a `FromIterator` block while the
pre-existing one further down the file survived the edit.

## Why it is worth fixing

The evaluator accepts a repeated trait registration for the same type without a
diagnostic — the same silence `DUPLICATE_INHERENT_METHOD_REJECTION` is filed
about for inherent methods. Two copies of one contract in one file means a
future fix (say, `try_insert` instead of `insert`, or reserving capacity) can be
applied to the copy that does not win, and the tests would still pass.

## Fix

Delete the undocumented first block (lines ~419-433) and keep the documented
one. No behaviour change; `tests/collections/hash_set.test.yo`'s `collect` cases
are the guard.
