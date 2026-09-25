# Worker-pool threads are neither joined nor detached, so every pool thread leaks its OS thread record

**Found:** 2026-09-25, by the ThreadSanitizer CI job on PR #902 (`plans/PARALLELISM_SOUNDNESS.md`
Phase 6) — the first TSan run over the thread corpus after the pool's `atexit` shutdown stopped
joining (`issues/fixed/worker-pool-atexit-shutdown-joins-workers-blocked-in-a-task.md`).
**Status:** FIXED 2026-09-25 (`plans/PARALLELISM_SOUNDNESS.md` Phase 6). **Resource leak; a TSan
error on every program that uses the pool.**
**Where:** `src/codegen/parallelism/runtime.yo`, `__yo_worker_pool_init`.

## Symptom

```
✗ Channel send from pool task recv from main        (tests/sync/channel.test.yo, TSan build)
  WARNING: ThreadSanitizer: thread leak (pid=3370)
    Thread T2 (tid=3373, finished) created by thread T1 at:
      #0 pthread_create
      #1 __yo_worker_pool_init
      #2 __yo_worker_spawn
  And 1 more similar thread leaks.
```

## Mechanism

`__yo_worker_pool_init` creates each worker with `__yo_raw_thread_create` and stores the handle
in `worker->handle`. The handle was consumed ONLY by the old `atexit` shutdown's
`__yo_raw_thread_join`. The Phase 6 fix removed that join, because joining hung the process on a
worker blocked in a task and deadlocked when `exit()` ran on a pool thread. After that nothing
joined or detached a worker. A POSIX thread that is neither joined nor detached keeps its thread
record (stack bookkeeping, exit status) until the process ends. On Windows the `_beginthreadex`
handle is likewise never closed. TSan reports this as a thread leak at exit.

## Fix

Detach each worker right after it is created (`__yo_raw_thread_detach`: `pthread_detach`, or
`CloseHandle` on Windows). The pool never joins, so this is the handle's whole lifecycle, and it
matches how a dropped `Thread` handle detaches. A worker idle at shutdown sees the flag and exits.
Its record is reclaimed at once because it is detached. A worker mid-task is reclaimed by process
teardown.

## Gate

The TSan job (`scripts/tsan-thread-corpus.sh`, the "ThreadSanitizer (sync primitives —
Linux/Clang)" check) runs `tests/sync/channel.test.yo` under `-fsanitize=thread`. There, "thread
leak" fails the test. It failed before this fix and passes after.
