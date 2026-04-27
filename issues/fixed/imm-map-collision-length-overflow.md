`std/imm/map.yo` stored collision bucket length in `u8`.

## Problem

- Inserting more than 255 keys with the same hash wrapped `_pairs_len`, corrupting collision-node bookkeeping.

## Symptoms

- Lookups fail or entries disappear once a collision bucket grows past 255 elements.
- Persistent updates/removals can operate on truncated collision arrays.

## Fix

- Widened collision lengths and related offsets/counts from `u8` to `usize`.
- Added a regression in `tests/imm_map.test.yo` that inserts 260 colliding keys and verifies every lookup.
