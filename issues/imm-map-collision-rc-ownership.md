`std/imm/map.yo` collision buckets did not handle RC-backed entries correctly.

## Problems

- `MapCollision.dispose` freed `_pairs_ptr` without dropping each `Pair(K, V)` first.
- `_copy_pairs` used plain assignment into freshly allocated memory.
- Fresh collision-pair writes during insert and `map_values` also skipped the uninitialized-memory ownership pattern.

## Symptoms

- Crashes when collision nodes copy RC-backed values such as `imm.String`.
- Leaks when old collision nodes are dropped after persistent updates.

## Fix

- Drop every stored pair before freeing a collision bucket.
- Use `consume(...)` for pair copies and fresh writes into newly allocated collision buffers.
- Added a regression in `tests/imm_map.test.yo` using colliding keys with `imm.String` values.
