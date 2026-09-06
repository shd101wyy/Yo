# `BTreeMap.insert` dropped the old value and, with `PriorityQueue.push`, discarded `push`'s `Result` before `len() - 1`

**Status: FIXED** (2026-09-06, `std/collections/btree_map.yo`,
`std/collections/priority_queue.yo`). Found by the std API audit —
`plans/STD_API_STABILIZATION.md` §3 item 16.

## Symptoms

1. `BTreeMap.insert(k, v) -> unit`. Rust's `BTreeMap::insert` returns
   `Option<V>` — the value that was replaced — and callers rely on it
   ("was this key new?", "give me back what I overwrote"). Yo's threw the old
   value away with no way to observe it short of a `get` beforehand.
2. Both `BTreeMap.insert` (new-key path) and `PriorityQueue.push` called
   `self._entries.push(...)` / `self._data.push(val)` and ignored the returned
   `Result`, then computed `len() - 1`. On an allocation failure nothing was
   stored, `len()` was unchanged, and for an empty container `len() - 1`
   underflowed to `usize::MAX` — the sift/shift loop then indexed off the end.

## Fix

- `insert -> Option(V)`: `.Some(old)` when the key existed, `.None` when it
  was new. The one caller pattern that changes is `m.insert(k, v);` as a
  statement, which still compiles (the value is simply unused).
- Both `push` results are checked; failure is the same panic
  `ArrayList.with_capacity` raises (`… : allocation failed`), so the container
  is never left half-updated. (D9 — infallible `push` + `try_push` — will make
  the guard the default shape; until then it is explicit here.)

## Regression test

`tests/collections/btree_map.test.yo` — "insert returns None for a new key and
Some(old) when it replaces" (and the new value is what `get` sees, and the map
does not grow).
