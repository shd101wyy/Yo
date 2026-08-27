# `sizeof(T) * count` was unchecked in every collection — silent heap corruption

**Found**: 2026-08-27, following the C33/C34 dead-surface audit —
`HashMapError.CapacityOverflow` and `HashSetError.ElementNotFound`'s sibling
`CapacityOverflow` are declared but never constructed, which asked why the check
they name does not exist. **Fixed**: same day. `std/allocator`'s
`size_would_overflow` — exported and, until now, called by NOTHING — is the
guard.

## Symptom 1: a capacity that wraps hands malloc a tiny size

`ArrayList.with_capacity(cap)` computed `malloc(sizeof(T) * cap)` with no
overflow check. For `T = u64` and `cap = 2^61`, `8 * 2^61` is `2^64`, which wraps
to **0**: `malloc(0)` returns a valid minimal block, the list records
`_capacity = 2^61`, and every push writes outside the allocation.

```
$ ./capacity_overflow_repro          # before
requesting with_capacity(2305843009213693952) for u64 (sizeof 8)
sizeof(u64) * cap wraps to: 0
survived allocation; reported capacity = 2305843009213693952
pushed 3, len = 3
read back: 1111111111111 2222222222222 3333333333333     ← 24 bytes into a 0-byte block
```

It "worked" only because a macOS `malloc(0)` block has slack; with a different
allocator or a few more elements this is a corrupted heap, and no diagnostic
fires anywhere along the way. `with_capacity` is precisely where an untrusted
count lands — the "read a length prefix, preallocate that many" pattern.

## Symptom 2: `ensure_total_capacity` spins forever

The same wrap has a second face. The growth loop was

```rust
cap := self._capacity;
while(cap < min_cap, { cap = (cap * usize(2)); });
```

Once `cap * 2` wraps to 0 it can never reach `min_cap`, so
`ensure_total_capacity(2^63 + 1)` never returns — an infinite loop rather than a
failure.

## Symptom 3: the HashMap/HashSet check that was declared and never written

`_alloc_with_capacity` computed `capacity * bucket_size` unchecked in both
containers, while their error enums declared the `CapacityOverflow` variant for
exactly that condition and nothing ever produced it.

## Also fixed: the power-of-two rounding dropped its last step

`HashMap.with_capacity` / `HashSet.with_capacity` round the request up to a
power of two by smearing the top bit down with shifts of 1, 2, 4, 8, 16 — and
stopped there. `usize` is 64-bit, so the `>> 32` step was missing and any
request above 2^32 rounded to a value that is **not** a power of two, though the
doc and the bucket masking (`hash & (capacity - 1)`) both require one. Not
independently observable (a >4 GB control allocation fails first), but the code
now does what it says.

## Fix

- `ArrayList.with_capacity` and `ArrayList.ensure_total_capacity` guard with
  `size_would_overflow(T, cap)` and panic with `"capacity overflow"` — the
  contract these two already had for allocation failure, and what Rust's
  `Vec::with_capacity` does.
- The growth loop clamps to `min_cap` only when doubling would wrap
  (`cap > SIZE_MAX / 2`), so ordinary growth keeps doubling. Pinned:
  capacity 4 + `ensure_total_capacity(10)` still yields **16**, not 10.
- `HashMap._alloc_with_capacity` / `HashSet._alloc_with_capacity` return
  `.Err(.CapacityOverflow)`, so the variant is live where the internal `Result`
  flows (the public constructors turn it into their existing allocation panic).
- Both power-of-two roundings gained the `>> 32` step.

Verified after the fix: the `with_capacity` reproducer aborts with
`"ArrayList.with_capacity: capacity overflow"` (rc 134) instead of corrupting
the heap, and the `ensure_total_capacity` reproducer aborts immediately instead
of hanging, while normal growth and element contents are unchanged.

## Tests

- `tests/allocator.test.yo` (new, 4 tests) pins `size_would_overflow` at its
  exact boundary (`SIZE_MAX / 8` fits, one more does not), on the wrap-to-zero
  cases (`u64 * 2^61`, `u32 * 2^62`), on ordinary counts, and `layout_of`
  alongside it. The helper had **no** test coverage before.
- `tests/collections/array_list.test.yo` gains
  `ensure_total_capacity keeps doubling and preserves elements`, the regression
  guard for the clamp.
- Full `tests/collections` directory green (392).

The panic paths themselves are not unit-testable — the suite has no
expect-panic facility, and an aborting test kills the runner — so they are
pinned by the two reproducers recorded above rather than by tests.

## Follow-up (not fixed here)

`HashMapError.KeyNotFound` and `HashSetError.ElementNotFound` remain dead, and
unlike `CapacityOverflow` they are dead **by design**: lookups return `Option`,
so a not-found *error* has no producer and needs none. Deleting them is a
breaking change to a public enum, so it belongs to the pre-S5 deletion sweep
(`plans/STD_API_AUDIT.md` §6) rather than to this memory-safety fix.
`std/allocator`'s `Layout` / `layout_of` are also unconsumed in-tree — there is
no `alloc(Layout)` entry point that would use them — which is worth a decision
in the same sweep.
