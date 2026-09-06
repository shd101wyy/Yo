# `HashMap` / `HashSet` tombstones were never reclaimed — churn drove every probe to O(capacity)

**Status: FIXED** (2026-09-06, `std/collections/hash_map.yo`,
`std/collections/hash_set.yo`). Found by the std API audit —
`plans/STD_API_STABILIZATION.md` §3 item 13.

## Symptom

`remove` marked the slot `CTRL_DELETED` (a tombstone, so probe chains through
it stay intact) and nothing ever counted or cleared those marks:

- `_needs_resize` compared only the live `size` against the 7/8 load
  threshold, so a table with a steady population never resized however many
  tombstones it accumulated;
- `_find_bucket` stops only at an `EMPTY` slot, and a tombstone is not one.

Under insert/remove churn (a cache, a session table, a worklist) the `EMPTY`
slots are consumed one by one until none is left. From then on **every miss
probes the entire capacity** — a `get` of an absent key over a 131,072-slot
table costs 131,072 comparisons — and `insert` of a new key, which looks the
key up first, pays the same. Correct answers, O(capacity) each.

## Fix (hashbrown's rules)

1. A `tombstones` field. `remove` increments it, `insert` into a tombstone
   decrements it, `clear` and `_resize` zero it.
2. `_needs_resize` counts `size + tombstones`, so tombstones cost load like
   live entries do and the table always keeps `EMPTY` slots.
3. When the threshold is reached because of tombstones — `(size + 1) * 2 <=
   capacity` — the table is **rehashed in place at the same capacity**, which
   clears every tombstone, instead of doubling. A steady population under
   churn therefore never grows.
4. `remove` puts the slot straight back to `EMPTY` when the *next* slot is
   `EMPTY`. Linear probing stops at the first `EMPTY`, so no live key's probe
   chain passes through such a slot (invariant: an `EMPTY` slot is on no live
   chain — inserts only ever fill slots whose predecessors are all non-`EMPTY`,
   and this rule only empties a slot whose successor is already `EMPTY`).
   Isolated keys are removed for free.

## Regression tests

`tests/collections/hash_map.test.yo` / `hash_set.test.yo`, "Tombstone
reclamation": an isolated remove leaves `tombstones == 0`; 20,000 remove+insert
rounds over 2,000 live entries keep `len + tombstones <= threshold` at every
step, leave `capacity` unchanged, and every live key is reachable with its
value while every retired key is absent (the soundness canary for rule 4).
The `tombstones` field is read directly — it is the observable; wall-clock
would be a flaky proxy.
