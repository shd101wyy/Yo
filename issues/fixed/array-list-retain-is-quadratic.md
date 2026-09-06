# `ArrayList.retain` was O(n²) with an allocation per rejected element

**Status: FIXED** (2026-09-06, `std/collections/array_list.yo`). Found by the
std API audit — `plans/STD_API_STABILIZATION.md` §3 item 14.

## Symptom

`retain` walked backwards and called `drain(i .. i + 1)` for every rejected
element. `drain` shifts the tail down (O(n)) and allocates a one-element
result list, so rejecting k of n elements cost O(k·n) time and k allocations.
`retain` over a 100k-element list that drops half of it did ~2.5·10⁹ element
moves.

That shape was chosen deliberately: the first implementation compacted through
raw pointers and double-released RC elements (Linux-ASan heap-use-after-free
on PR #313's first run), and `drain` was the module's proven RC path.

## Fix

One pass over public, proven operations — no raw-pointer compaction:

```rust
n := self._length;
kept := Self.with_capacity(n);
… for each i: v := self(i); if pred(v) { kept.push(v); } …
self.clear();        // releases every original
self.extend(kept);   // copies the survivors back
```

RC accounting: a survivor is dup'd by `push` (2), released by `clear` (1),
dup'd by `extend` (2), released when `kept` drops (1) — net zero; a rejected
element is released by `clear` — net −1. O(n) time, one allocation.

## Regression test

`tests/collections/array_list_convenience.test.yo` — the existing order/RC
tests plus a 20,000-element retain sharing one RC value across the survivors,
whose refcount is checked with the `rc()` witness before and after.
