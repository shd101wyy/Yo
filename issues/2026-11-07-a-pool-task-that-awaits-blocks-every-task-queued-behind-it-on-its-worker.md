# A pool task that awaits blocks every task queued behind it on its worker, while other workers idle

**Severity:** S2 — a `ThreadPool` task can wait for seconds, or forever, behind
an unrelated task even though another worker has nothing to do. Throughput and
latency are wrong for any pool mixing slow async tasks with short ones, and a
task that never completes (an accept loop) starves the tasks assigned to its
worker permanently.

**Status:** OPEN. Filed 2026-11-07 from VERDICTS-32 §3.2. Fixed by TP-1
([`plans/backlog/THREAD_POOL_OWNED_WORKERS_AND_SHARED_QUEUE.md`](../plans/backlog/THREAD_POOL_OWNED_WORKERS_AND_SHARED_QUEUE.md),
v0.2.80). The test, `tests/thread_pool_shared_queue.test.yo`, lands with that
fix.

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
