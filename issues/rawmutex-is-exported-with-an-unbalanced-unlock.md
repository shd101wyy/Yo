# `RawMutex` is exported with manually balanced `lock`/`unlock`, so safe code reaches mutex UB

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-6).
**Status:** OPEN. **Undefined behaviour reachable from safe code.**
**Measured:** by reading `std/sync/mutex.yo` (~93-105, export at ~260) and the C macros in
`src/codegen/types/generation.yo` (~604-678).

## Mechanism

```rust
{ RawMutex } :: import("std/sync/mutex");
main :: (fn() -> unit)({
  r := RawMutex.new();
  r.unlock();           // pthread_mutex_unlock on a mutex nobody holds: UB (glibc: silently ok, then
});                     // a later unlock steals the lock from a real owner); Windows: corrupts the CS
```

`RawMutex.lock` twice from one thread deadlocks on POSIX and re-enters on Windows (the type doc
says "platform-defined"). `unlock` from a non-owner thread is UB on both. The doc calls balancing
"the caller's job", which is a pragma-level contract on a pragma-free API. The only std user is
`ThreadPool._mutex` (`std/thread.yo`), which needs exactly the lock-here/unlock-there shape
because the runtime's inline fallback runs a task INSIDE the submission critical section
(`_lock_for_submission` / `_unlock_after_submission` and their `_held`/`_owner` protocol).

## Fix direction

Keep the type (the pool needs it) but make misuse a trap instead of UB: `RawMutex` tracks its
owner thread id (`_owner : AtomicUsize`, `usize(0)` = unheld; `__yo_thread_self()` is never 0 on
any supported platform — assert that in `new`). `lock` panics if `_owner == me` (self-relock),
`unlock` panics unless `_owner == me`, `try_lock` returns `false` for the owner instead of
Windows' recursive `true`. `ThreadPool`'s own `_held`/`_owner` then become redundant and are
removed in the same change (the RawMutex answers "do I hold it"). Tests in
`tests/sync/mutex.test.yo`: `unlock` without `lock` traps; `lock` twice traps on every platform
(today it is a hang on POSIX, which no test can pin).
