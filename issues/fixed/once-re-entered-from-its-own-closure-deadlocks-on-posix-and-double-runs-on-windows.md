# `Once.call` / `OnceCell.get_or_init` re-entered from `f` deadlocks on POSIX and runs `f` twice on Windows

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-8).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 5, rule D5). Was: **Platform-divergent; a data race on Windows.**
**Measured:** by reading `std/sync/once.yo` (`call` ~105-122, `get_or_init` ~173-178) and
`std/sync/mutex.yo` (`with_lock`); not run.

## Mechanism

`f` runs inside `self._mutex.with_lock`. If `f` calls the same `Once` / `OnceCell` again:

- POSIX: `pthread_mutex_lock` on a default mutex the thread already holds — deadlock, forever,
  with no diagnostic.
- Windows: the `CRITICAL_SECTION` is recursive, the inner call's relaxed double-check sees
  `_done == false`, the INNER `f` runs and publishes `_done = true` (and `_value` for
  `OnceCell`); the OUTER `f` then continues and writes `_value` a second time AFTER `_done` is
  true. Any thread that observed `is_done()` meanwhile reads `_value` in `get()` concurrently
  with that non-atomic overwrite. "Exactly once" is violated and the read races.

```rust
cell := OnceCell(i32).new();
v := cell.get_or_init(() => {
  _ := cell.get_or_init(() => i32(1));
  i32(2)
});   // POSIX: hangs; Windows: 1 was published, then overwritten by 2
```

Rust: `OnceCell::get_or_init` panics on re-entrancy, `OnceLock` deadlocks; `once.yo` documents
neither.

## Fix direction

Detect and trap: `Once` records the initializing thread id (`_owner : AtomicUsize`, set before
`f` runs, cleared after the Release store); a `call` that finds `_owner == me` panics
`"Once.call: re-entered from its own initializer"` on every platform. Falls out of the owner
tracking added to `Mutex(T)` for
`issues/fixed/cond-wait-with-does-not-check-that-the-caller-holds-the-mutex.md`, so it is the same
change. Test: the repro above expects rc 134 with that message.

## Fix (2026-09-26)

`Once` records the initializing thread (`_owner : AtomicUsize`, set before `f` runs, cleared
after the `_done` release store); a `call` from that thread panics
`Once.call: re-entered from its own initializer` on every platform, before the (now also
self-relock-trapping) mutex is touched. `OnceCell.get_or_init` inherits it. Test:
`tests/cli-cases/once-reentrant-call-panics`.
