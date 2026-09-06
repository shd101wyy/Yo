# `spawn(pool, …)` self-deadlocked on a nested spawn in the runtime's inline fallback

**Status: FIXED** (2026-09-06, `std/thread.yo`). Found by the std API audit —
`plans/STD_API_STABILIZATION.md` §3 item 3.

## Symptom

`spawn` takes the pool's submission mutex, calls `__yo_worker_spawn(cb)`, and
releases it. The mutex exists so that `join_all`'s one-sentinel-per-worker
submission is not interleaved with other submissions (round-robin placement).

When no worker thread could be created — standalone WASI, or `pthread_create`
failing — the runtime runs the task **inline on the submitting thread**
(`codegen/parallelism/runtime.yo`, the fix for
`issues/fixed/wasi-thread-pool-submit-deadlock.md`). That call happens inside
`spawn`'s critical section, so a task that itself calls `spawn(pool, …)`
blocks on the mutex its own thread already holds: a self-deadlock with no
diagnostic, in exactly the environment the inline fallback was added for.

## Fix

The submission lock is made re-entrant for its owner. `ThreadPool` records
`_owner` (the submitting thread's id) and `_held`; `_lock_for_submission`
skips the mutex when the caller already holds it and reports whether it took
it, and `_unlock_after_submission` releases only what was taken. Ordering:
`_owner` is written before `_held` (Release) and `_held` is read before
`_owner` (Acquire), so a thread that observes `_held` observes the owner who
set it; a stale `_owner` can only be seen under `_held == false`, which takes
the lock as it should. `join_all` uses the same pair.

## Regression test

`tests/thread_pool.test.yo` — a task spawns a second task on the same pool;
the nested task's result arrives on a channel and `join_all` returns. With
worker threads this exercises the bookkeeping; in the inline fallback it is
the exact shape that deadlocked. (The fallback cannot be forced on a normal
host — it is taken only when thread creation fails.)
