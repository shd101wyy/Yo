# A pool task that awaits blocks every task queued behind it on its worker, while other workers idle

**Severity:** S2 — a `ThreadPool` task can wait for seconds, or forever, behind
an unrelated task even though another worker has nothing to do. Throughput and
latency are wrong for any pool mixing slow async tasks with short ones, and a
task that never completes (an accept loop) starves the tasks assigned to its
worker permanently.

**Status:** FIXED 2026-11-22 by TP-1
([`plans/reference/THREAD_POOL_OWNED_WORKERS_AND_SHARED_QUEUE.md`](../../plans/reference/THREAD_POOL_OWNED_WORKERS_AND_SHARED_QUEUE.md),
v0.2.80). Was: OPEN, filed 2026-11-07 from VERDICTS-32 §3.2. Test:
`tests/thread-pool-shared-queue.test.yo`, "a task queued behind an awaiting
task starts on the idle worker".

## Reproduction

`issues/repros/2026-11-07-pool-task-head-of-line-blocking.yo` sets up the
pool and three tasks:

- **Pool:** `ThreadPool.new(usize(2))`.
- **Task A:** `io.await`s `sleep(2000 ms)`.
- **Task B:** returns at once.
- **Task C:** prints how long after the start it began.

Measured 2026-11-07 with the develop-built `yo-r2h` binary (develop
`8d475cd81`), three runs:

```
third task started after 2000 ms
all done after 2000 ms
```

Task B finished immediately, so worker 1 was idle for the whole 2 s. Task C
still waited for task A.

## Root cause

`src/codegen/parallelism/runtime.yo`:
- **Fixed assignment.** `__yo_worker_spawn` assigns every task to
  `__yo_worker_next_thread % num` (round-robin into per-worker queues).
- **No interleaving.** Each worker runs `task->fn(task->closure)` followed by
  `__yo_async_wait_all()` before it dequeues the next task, so tasks on one
  worker never interleave.

A tells worker 0 to wait for its timer. B goes to worker 1 and finishes. C is
placed on worker 0 by the counter, so it waits behind A. Nothing moves an
unstarted task to an idle worker.

## Fix (TP-1)

All unstarted tasks go into one intake queue shared by the workers, and an
idle worker takes the next one. Taking an unstarted `FnOnce + Send` task is
sound. A started task never migrates (`Io` and `JoinHandle` are `!Send`).
Explicit pinning remains available as `spawn_on(pool, i, cb)`.

## Fix (2026-11-22, TP-1)

`src/codegen/parallelism/runtime.yo` replaces the process-global statics
with a pool handle, `__yo_worker_pool_t`, made by
`__yo_worker_pool_create(n)` with exactly `n` joinable workers.

- **One shared queue.** `__yo_worker_pool_submit` appends to the pool's
  shared queue and wakes one sleeping worker; a worker that finishes a task
  takes the next one from it. Task C goes to the worker that finished task B.
- **Pinning is explicit.** `__yo_worker_pool_submit_to(pool, i, ...)` appends
  to worker `i`'s own queue, which only worker `i` takes, before the shared
  one (`std/thread`'s `spawn_on`).
- **A started task never moves.** A worker still runs a task to completion,
  `__yo_async_wait_all` included, before it takes the next one.

`std/thread.yo`'s `ThreadPool` owns the handle: `Drop` is `shutdown`, which
closes the pool and joins its workers (`__yo_worker_pool_shutdown_join`), then
releases it (`__yo_worker_pool_destroy`).

Verified with the test above, which measures how long after the start task C
began: under 1000 ms with the fix (the issue's ~2000 ms without it).
