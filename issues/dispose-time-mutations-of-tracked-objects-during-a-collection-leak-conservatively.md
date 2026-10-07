# Dispose-time mutations of tracked objects during a collection leak conservatively

**Severity:** S3. A conservative memory leak (never memory unsafety), bounded by what `dispose` code does while a collection runs.

**Status:** OPEN (filed 2026-10-06, surfaced while fixing
`issues/fixed/a-dispose-that-resurrects-a-cycle-member-leaves-a-dangling-handle.md`).

## Reproducer

A `Dispose` whose body allocates a tracked object (here `scratch`, whose only
reference dies with the dispose body):

```rust
N :: ref(struct(v : i32, next : Option(Self)));
impl(
  N,
  Dispose(
    dispose : (fn(self : Self) -> unit)({
      scratch := N(9, .None);
    })
  )
);
// a <-> b unreachable cycle; Gc.collect() runs both disposes.
```

Measured 2026-10-06 (Windows, seed v0.2.52 and the tree compiler):

```
after first collect tracked=2   // a, b reclaimed; the TWO scratch nodes (one per dispose) stay
after second collect tracked=2  // never reclaimed, although unreachable since the disposes returned
```

## Root cause

While `__yo_gc_collecting` is set, `__yo_decr_rc_tracked`
(`src/codegen/functions/gc_runtime.yo`) skips every decrement of a tracked
object. The skip is load-bearing: a decrement that reached 0 mid-pass would free
a white cell under the collector's feet (a use-after-free). But dispose passes
run arbitrary user code, so the skip also swallows decrements that have nothing
to do with the trial-deleted subgraph:

- an object allocated by dispose code loses its local's scope-end decrement, so
  its count keeps the `+1` and no later collection ever classifies it garbage
  (the measured `tracked=2` above; the objects are eventually freed only by the
  thread-exit teardown, which frees everything);
- a reference to a LIVE object dropped by dispose code (e.g. a field overwrite
  `k.next = ...` during a dispose) loses its decrement the same way, leaving the
  live object a phantom `+1` — verified as the intentional leak of the
  both-disposes-store shape in `tests/cycle_collector.test.yo` ("A dispose that
  resurrects a cycle member leaves no dangling handle" leaves its pair leaked;
  the following test's comment documents why).

The resurrection re-check added by the S1 fix relies on this one-sidedness (a
white count can only have risen), so the leak is the deliberate conservative
direction: leak, never dangle.

## Fix direction

Queue dispose-time tracked decrements (a small per-collection pending-decrement
log) instead of skipping them outright, and replay the queue after the free
pass, when freeing is safe again; ditto for dispose-time allocations, whose
locals' scope-end decrements currently vanish. The queue must be bounded or
spilled, and replay must re-enter `__yo_decr_rc_tracked` with collecting
cleared. Until then this is documented behavior
(docs/en-US/CYCLE_COLLECTION.md, "Resurrection during dispose").

## Test

Lands with the fix: the reproducer above, asserting `Gc.tracked_count()` returns
to its baseline after a second `Gc.collect()`.
