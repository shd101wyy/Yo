# A `dispose` that stores a cycle member into a live object leaves a dangling handle after `Gc.collect()`

**Severity:** S1. The cycle collector frees an object that a `dispose` has made reachable again, so a live object keeps a handle to freed memory, which is a use-after-free.

**Status:** FIXED 2026-10-06 (was OPEN, filed 2026-10-06, found by the VALUES_BY_DEFAULT closure audit, decision 38 / N10; fixed by the PEP 442 resurrection re-check in `src/codegen/functions/gc_runtime.yo`).

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

Measured on 2026-10-06 with a tree-built compiler (develop and V3, `gatelogs/yo-v3m-s1`), macOS arm64. ASan was unavailable in that toolchain, but the count and tracked-count readout shows the free. Reproduced on Windows (MSVC heap) before the fix as `resurrected v=2 rc=1440219472 tracked=1` — the garbage `rc` is the freed block reused; after the fix it reads `resurrected v=1 rc=2 tracked=3`.

## Root cause

`CollectWhite` (docs/en-US/CYCLE_COLLECTION.md, "Collect", step 3) disposes the white subgraph and then frees it, in two passes. A dispose runs user code, and that code can store a handle to a white member into a live object. The member's count rises, but the free pass frees it anyway.

## Fix

PEP 442-style, in `src/codegen/functions/gc_runtime.yo`, in BOTH collectors:

- the incremental collector (`__yo_gc_collect_incremental`) re-checks every gathered
  white cell after its dispose pass: a cell whose `(ref_count & __YO_RC_COUNT)` rose
  above the trial-deleted 0 — and everything reachable from it — is turned black via
  `__yo_gc_scan_black` (which also restores the trial decrements over that subgraph),
  and the free pass skips whatever is no longer marked with the gather sentinel;
- the thorough full-heap collector (`__yo_gc_collect`) does the same between its
  dispose pass and its free walk: garbage-marked cells whose count rose go back to
  black and the free walk leaves them tracked and allocated.

The check is one-sided by construction: tracked decrements are skipped while
`__yo_gc_collecting` is set (that skip is what keeps a mid-pass decrement from
freeing a white cell under the collector's feet), so a white count can only have
RISEN since classification. Dispose-time mutations therefore err toward keeping —
a leak, never a dangling handle. Two consequences worth knowing:

- a reference that one dispose resurrects and a LATER dispose in the same pass
  overwrites keeps a phantom count (the overwrite's decrement is skipped), so that
  object stays leaked — the conservative bound;
- more generally, tracked allocations and drops performed by dispose code during a
  collection are accounted conservatively (see
  `issues/dispose-time-mutations-of-tracked-objects-during-a-collection-leak-conservatively.md`,
  filed with this fix).

A kept cell is only leaked from THAT collection: once it is unreachable again, a
later collection reclaims it (when its counts are exact — see the second test).

## Test

`tests/cycle_collector.test.yo`:

- "A dispose that resurrects a cycle member leaves no dangling handle" — the
  reproducer's shape (both disposes store into the live keeper), asserting via
  `Gc.tracked_count()` — read before any dereference of the possibly-dangling
  handle, so the pre-fix failure is deterministic — that all three nodes stay
  tracked, then that the kept node is readable with a count of at least 1;
- "A resurrected pair is reclaimed once unreachable again" — a single storing
  dispose (exact counts), asserting the whole pair is kept, then that dropping
  the resurrected reference and refusing further stores lets a later
  `Gc.collect()` reclaim the pair.

Both fail before the fix (exit 22 on the first assert) and pass after.
