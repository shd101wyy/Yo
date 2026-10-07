# A `dispose` that stores a cycle member into a live object leaves a dangling handle after `Gc.collect()`

**Severity:** S1. The cycle collector frees an object that a `dispose` has made reachable again, so a live object keeps a handle to freed memory, which is a use-after-free.

**Status:** OPEN (filed 2026-10-06, found by the VALUES_BY_DEFAULT closure audit, decision 38 / N10).

## Reproducer

`issues/repros/a-dispose-that-resurrects-a-cycle-member-leaves-a-dangling-handle.yo`:
- two `ref(struct)` nodes `a` and `b` form a cycle and become unreachable;
- each one's `Dispose` writes its `next` (the other cycle member) into a **live** node `k`;
- `main` calls `Gc.collect()` and then reads `k.next`.

```
$ yo compile issues/repros/a-dispose-that-resurrects-a-cycle-member-leaves-a-dangling-handle.yo --optimize 0 --allocator system -o r && ./r
resurrected v=0 rc=0 tracked=1
```

Expected: the resurrected node is still alive, so `v` is 1 or 2, its count is at least 1, and the tracked count is at least 2. Instead `k.next` points at a freed node: count 0, `v` zeroed, and only `k` still tracked.

Measured on 2026-10-06 with a tree-built compiler (develop and V3, `gatelogs/yo-v3m-s1`), macOS arm64. ASan was unavailable in this toolchain, but the count and tracked-count readout shows the free.

## Root cause

`CollectWhite` (docs/en-US/CYCLE_COLLECTION.md, "Collect", step 3) disposes the white subgraph and then frees it, in two passes. A dispose runs user code, and that code can store a handle to a white member into a live object. The member's count rises, but the free pass frees it anyway.

## Fix direction

After the dispose pass, re-check each white cell's count against its trial-deleted internal count, as CPython's PEP 442 does. A cell that was resurrected, and everything reachable from it, is turned black and kept (leaked from this collection) instead of freed. This applies to both the incremental collector and the full `__yo_gc_collect` scan.

## Test

The fix lands with `tests/` coverage of this reproducer that asserts the resurrected node survives and is freed by a later collection once it is unreachable again. The test fails before the fix.
