# Every thread creates an io_uring ring, and thread churn runs out of memory

**Found:** 2026-09-26, on develop run 36206559953 (the first full battery over #902) and PR #932:
the `ThreadSanitizer (sync primitives — Linux/Clang)` job.
**Status:** FIXED 2026-09-26. **Class:** runtime resource exhaustion (Linux, io_uring backend).

## Symptom

```
FAIL tests/cross_thread_wake.test.yo rc=1 spawns=192 tsan_reports=0
  ✗ spawn_blocking from a task on a spawned thread, 2000 times: each loop outlives the release posted into it
    [Yo] io_uring_queue_init failed: Cannot allocate memory
```

On other runs `tests/thread.test.yo` died partway through its 5000-iteration nested-thread test
(`spawns=9361` of about 10039), and `tests/cross_thread_wake.test.yo` at `spawns=1884` of 4014.
The same runs were green on most retries: the failure depends on how fast the kernel reclaims.

## Cause

Every event loop called `__yo_io_init` when it started (`__yo_async_run_until_complete`,
`__yo_async_wait_all`), so every `Thread.spawn` body, pool worker loop and `spawn_blocking`
awaiter created its own 1024-entry io_uring ring, and destroyed it when the thread exited. The
kernel charges a ring's memory (about 100 KB at 1024 entries: the SQE array, both rings) to the
user's `RLIMIT_MEMLOCK` and returns it only when the ring's deferred teardown work runs. A loop of
short-lived threads, each joined before the next, still held dozens of dead rings' charges at once.
`io_uring_queue_init` then failed with `ENOMEM`, and `__yo_io_init` exited the process with
rc=1. Under TSan, which slows everything else down, it took fewer than a hundred threads.

Most of those loops never needed a ring. A loop that only waits for a wake (a `spawn_blocking`
await, a `Park`, a cross-thread waker) submits no I/O. The ring served it only as a way to block on
the loop's wakeup eventfd.

## Fix

`src/codegen/async/runtime_io_linux.yo`:

- The ring is created on the loop's first I/O submission (every `__yo_async_*_start` already
  called `__yo_io_init`), never at loop start. `runtime_core.yo` calls a per-backend
  `__yo_io_loop_start` hook instead. It does nothing on io_uring. kqueue, IOCP, wasm and the
  no-liburing stub still initialize there.
- The wakeup channel (`__yo_io_notify_init`: the eventfd, published under the loop's lock) is
  separate from the ring. A loop with no ring blocks in `poll()` on the eventfd. Its first wait
  only creates the eventfd and returns, so the loop re-checks before blocking. A wake posted
  before the eventfd was published is visible to that check (it bumped `xwake_count` under the
  same lock). A wake posted after it writes the eventfd.
- `__yo_io_poll` with no ring ticks only the poll and fs-event watches. `__yo_io_cleanup` closes
  an eventfd-only loop without touching a ring.

A thread whose loop only waits now costs one descriptor, no locked memory.

## Regression tests

The Linux TSan thread corpus (`scripts/tsan-thread-corpus.sh`):

- `tests/cross_thread_wake.test.yo`: "spawn_blocking from a task on a spawned thread, 2000 times";
- `tests/thread.test.yo`: "Test a spawned thread joins a thread of its own, 5000 times".

Both failed with `ENOMEM` before the fix, and now create no ring at all.
