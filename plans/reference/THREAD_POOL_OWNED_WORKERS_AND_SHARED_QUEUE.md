# `ThreadPool`: the pool owns its workers, unstarted tasks share one queue, and pinning is explicit

**Status: LANDED — TP-1, v0.2.80 (2026-11-22). Decided 2026-11-07
(VERDICTS-32 §3, maintainer adopted), before
[`NO_LIBC_BY_DEFAULT`](../backlog/NO_LIBC_BY_DEFAULT.md) P5. Not seed-gated.
§0 is the state before TP-1; §7 records where the landed code refines §2 and
§3.**

The maintainer asked on 2026-11-07: "for parallelism, should we delete the
thread-per-core design? But I see that's only for ThreadPool so maybe it's
fine?"

**Answer:**
- **Delete** the pinned round-robin assignment as the default.
- **Keep** one event loop per worker.
- **Make** the pool a value that owns its workers.
- **Make** pinning explicit.
- **Retire** "thread-per-core" as a *name*, because the runtime never pinned
  a thread to a core.

Companion: [`IO_INTERFACE_AND_STD_RUNTIME.md`](../backlog/IO_INTERFACE_AND_STD_RUNTIME.md),
the `Io` half of the same consult.

## 0. What is true today (develop, 2026-11-07)

Line anchors are against `src/codegen/parallelism/runtime.yo` and
`std/thread.yo`.

- **There is no CPU pinning.** No `sched_setaffinity`,
  `pthread_setaffinity_np` or `SetThreadAffinityMask` exists anywhere under
  `src/codegen` (grep: 0 hits). "Thread-per-core" only ever meant that the
  default worker count is `__yo_get_hardware_threads()`. The `(CPU n)` labels
  in the old `PARALLELISM.md` diagram described nothing the runtime does.
- **Assignment is round-robin into per-worker queues**
  (`__yo_worker_next_thread % num` in `__yo_worker_spawn`), and it ignores
  load.
- **A worker runs one task at a time, to completion, including its async
  work.** `task->fn(task->closure)` is followed by `__yo_async_wait_all()`
  before the next dequeue. Tasks on one worker are never interleaved. A pool
  task that awaits something slow (an accept loop, a long `sleep`) blocks
  every task queued behind it on that worker, while other workers may sit
  idle. This is head-of-line blocking, and it is filed as an S2:
  `issues/fixed/2026-11-07-a-pool-task-that-awaits-blocks-every-task-queued-behind-it-on-its-worker.md`.
- **The pool is process-global.** The workers live in C statics:
  `__yo_worker_threads`, `__yo_worker_num_threads` and
  `__yo_worker_next_thread`.
  - `ThreadPool.new(n)` is a request: `__yo_worker_set_num_threads` is
    ignored once the pool is initialised.
  - Workers are detached at birth, and the `atexit` hook only signals them.
  - A slot with no thread runs the task inline on the submitter.
- **`join_all` is a completion counter** (since 2026-09-26), and each
  `ThreadPool` value counts its own tasks.

## 1. The position

| Aspect | Today | Position | Why |
| --- | --- | --- | --- |
| Assignment | Round-robin into per-worker queues, no stealing | **One shared intake queue.** An idle worker takes the next unstarted task. A started task never leaves its worker: the per-task `__yo_async_wait_all` drain stays | Taking *unstarted* `FnOnce + Send` tasks is sound by the type. Migrating *started* ones is not, and is not done. This removes the head-of-line blocking and the CPU-bound imbalance in one change, and nothing relies on placement since `join_all` became a counter. It is work-sharing, not work-stealing: one mutex-and-condvar queue, no per-worker deques, no atomics on async state |
| Pinning | Implicit, by submission order | **`spawn_on(pool, worker : usize, cb)`** submits to that worker's own queue, which the worker checks before the shared one | The one thing thread-per-core is *for* is shard-local state (Seastar, Glommio, Monoio), and that needs a stable worker identity chosen by the program, not by a counter. `pool.worker_count()` and the running task's `worker_id()` (a `thread_local` read) make a sharded design writable. "Affinity by argument" is the same rule as allocator placement by argument |
| Event loop | One per worker | **Kept** | Required by `!Send` `Io`/`JoinHandle` and the runtime's per-thread, non-atomic task objects. It is the design, not an option |
| Ownership | One process-global pool; `new(n)` is a request; pools share workers; `atexit` signals | **`ThreadPool.new(n)` creates exactly `n` workers.** Dropping the pool is `shutdown`: close, drain, join. Two pools are `2n` threads | A pool is a resource with a lifetime, as in Rust's `rayon::ThreadPool` and Zig's `std.Thread.Pool`. The "request" semantics were an artifact of the C statics. A pool held in a module global lives until exit, and the process does not wait for it (as today, and as for a detached `Thread`) |
| Count | Hardware threads by default | **Kept** as the default of `with_hardware_threads()`; `new(n)` is exact | |
| `join_all`, `shutdown` | Counter, close-and-drain | **Kept**, plus `Drop` joins | |
| Task value | `FnOnce(io : Io) -> unit` | **Kept** for `spawn` and `spawn_on`. A result comes back over a `Channel` | A `JoinHandle`-like pool handle is a later follow-up, not part of this change |
| Fork-join | None | **Not now.** `join(a, b)` and `par_for` come later, in a `std/thread/par` layer over VERDICTS-31 P6's `Thread.scope` (borrowed environments) and a `pool.scope(s => …)` twin | Scoped threads give the borrow story and a pool gives reuse. `par_iter` is sugar over both, and waits for both |
| A worker's `Io` | The worker's native loop | **Kept.** The entry hands `Io.native()` to every task | A pool never injects a non-native `Io`. A test that wants a simulated `Io` runs single-threaded |
| Inline fallback | A slot with no thread runs the task inline | **Kept** for a `new(n)` that could create no thread (standalone WASI): `worker_count() == 0`, every `spawn` runs inline, and `Drop` joins nothing | |

## 2. The surface after TP-1

```yo ignore
{ ThreadPool, spawn, spawn_on, worker_id } :: import("std/thread");

ThreadPool.new : (fn(num_threads : usize) -> ThreadPool);       // exactly `num_threads` workers, owned
ThreadPool.with_hardware_threads : (fn() -> ThreadPool);
ThreadPool.worker_count : (fn(self : &ThreadPool) -> usize);
spawn : (fn(pool : &ThreadPool, sink(cb) : Impl(FnOnce(io : Io) -> unit, Send)) -> unit);   // shared queue
spawn_on : (fn(pool : &ThreadPool, worker : usize, sink(cb) : Impl(FnOnce(io : Io) -> unit, Send)) -> unit);  // pinned
worker_id : (fn() -> Option(usize));                              // the running pool task's worker, .None elsewhere
ThreadPool.join_all : (fn(self : &ThreadPool) -> unit);           // completion counter over this pool's tasks
ThreadPool.shutdown : (fn(self : &ThreadPool) -> unit);           // close, drain, join; idempotent
// impl(ThreadPool, Drop(...)): drop = shutdown
```

`num_threads` is renamed `worker_count`, because it is now exact and names
the pool's own workers. There is no alias: Yo has no deprecation windows.

## 3. The runtime change (in C, once, before NO_LIBC P5)

`parallelism/runtime.yo`'s statics become a handle, `__yo_worker_pool_t`,
with four operations:

| Operation | Effect |
| --- | --- |
| `__yo_worker_pool_create(n)` | Creates `n` joinable workers, each with its own scheduler (`__yo_async_scheduler_init()`) |
| `__yo_worker_pool_submit(pool, fn, closure)` | Appends to the shared queue and signals one idle worker |
| `__yo_worker_pool_submit_to(pool, i, fn, closure)` | Appends to worker `i`'s own queue and signals that worker |
| `__yo_worker_pool_shutdown_join(pool)` | Closes the pool, wakes every worker, joins them and frees the handle |

A worker's loop:
1. Take from its own queue first, then from the shared queue.
2. Run the task, then `__yo_async_wait_all()`.
3. Repeat. Sleep on the pool's condition variable when both queues are empty.

`std/thread.yo`'s `_ThreadPoolState` holds the handle, and its `Drop` calls
`shutdown_join`. The `__yo_worker_set_num_threads` /
`__yo_worker_get_num_threads` request path and the `atexit` signal are
deleted. NO_LIBC P5/P6 then port these handles onto `clone`/`futex`, not the
former statics.

## 4. TP-1's gates (Tier 1)

- `yo check ./src` and `yo check ./std`, then `yo build --std-path ./std`.
- One file per `yo test` call:
  - `tests/thread_pool.test.yo`
  - `tests/thread.test.yo`
  - `tests/thread_safety.test.yo`
  - `tests/parallelism_soundness.test.yo`
  - `tests/spawn_blocking.test.yo`
  - `tests/cross_thread_wake.test.yo`
  - `tests/async/channel.test.yo`
  - `tests/async/mutex_threads.test.yo`
- **The new `tests/thread_pool_shared_queue.test.yo`**, from the issue's
  repro. It uses `new(2)` and three tasks:
  1. one `io.await`s a 2 s sleep;
  2. one returns at once;
  3. one must *start* well inside the sleep (a timer assertion with a wide
     margin), because the second worker is idle.

  It fails before TP-1 (the third task starts at ~2000 ms, behind the
  sleeper) and passes after it. Two sleepers would not test this: they keep
  both workers busy, and each worker runs one task at a time by design.
- A `spawn_on` test: tasks pinned to worker `i` observe
  `worker_id() == .Some(i)`.
- A `Drop` test: a pool dropped at the end of a block has run every submitted
  task.
- The `tests/internal/` files that import `parallelism/runtime`.
- Under Deferred: the TSan leg (develop's battery).
- Docs:
  - `docs/en-US/PARALLELISM.md` and `docs/zh-CN/PARALLELISM.md` take §5's
    text;
  - `std/thread.yo`'s module and type docs take it too;
  - the Thread-vs-ThreadPool comparison table's "Thread Affinity" row
    becomes "Pinning: explicit (`spawn_on`)".

## 5. The documentation text (lands with TP-1)

> A `ThreadPool` owns `n` worker threads, created by `new(n)` and joined when
> the pool is dropped or `shutdown`.
>
> Every worker has its own async event loop, so a task may use
> `io.async`/`io.await` on the `io` it is handed. A started task never moves
> to another thread: `Io` and `JoinHandle` are `!Send`, and reference counts
> are per-thread and non-atomic.
>
> Unstarted tasks wait in one queue shared by the workers. `spawn(pool, cb)`
> is taken by the first idle worker, so a slow task delays nothing queued
> behind it, and CPU-bound work balances itself.
>
> A task that must run on a particular worker, because of shard-local state
> or a per-worker cache, is placed explicitly with `spawn_on(pool, i, cb)`.
> Only that worker takes it (`pool.worker_count()`, `worker_id()`).
>
> Each worker runs one task at a time to completion, including the async
> work that task spawned. `join_all` is a completion counter over the tasks
> this pool submitted.
>
> There is no work stealing and no CPU affinity: the runtime never pins a
> thread to a core, and a started task never migrates.

## 6. Rejected

- **Round-robin assignment to per-worker queues with no sharing** (the
  former default). It causes head-of-line blocking: a task that awaits blocks
  every task queued behind it on its worker while other workers sit idle.
- **A process-global pool whose `new(n)` is a request.** This was an artifact
  of the C statics; a pool is a resource with a lifetime.
- **Work stealing of started tasks**, as in tokio or Zig's fiber stealing.
  The runtime's task objects are per-thread and non-atomic, and no future is
  `Send` while `Io` names one loop. A `Send`-gated `spawn_async` is deferred
  (`IO_INTERFACE_AND_STD_RUNTIME.md` §7).
- **Per-worker deques with stealing of unstarted tasks.** The shared queue
  gives the same balance for the task sizes a pool takes, with one lock and
  no atomics. Revisit only on a measured contention profile, after NO_LIBC
  P6.
- **CPU affinity syscalls** (actually pinning a thread to a core). Nothing
  asked for it, and it is not portable. `spawn_on` gives a program the stable
  worker identity that sharded designs need.
- **Fork-join `join`/`par_for` in this change.** They belong to a later
  `std/thread/par`, over scoped threads and `pool.scope`.

## 7. As landed (TP-1, 2026-11-22)

- **The runtime handle has two more entries than §3's four.**
  `__yo_worker_pool_worker_count(pool)` answers `worker_count()`, and
  `__yo_worker_pool_destroy(pool)` frees the handle. `shutdown_join` closes
  and joins but does not free, because `shutdown` is idempotent and callable
  through a shared `&ThreadPool` before the drop; only `Drop` calls `destroy`.
  `__yo_worker_current_index()` (a `_Thread_local` slot read, `SIZE_MAX` off a
  pool worker) backs `worker_id()`.
- **The task closure is the submission's last argument.** Codegen lowers
  `__yo_worker_pool_submit(pool, cb)` and `__yo_worker_pool_submit_to(pool,
  i, cb)` as it lowers `__yo_thread_spawn(cb)` (a wrapper plus a heap copy of
  the captures) and passes the arguments before the closure through
  (`src/codegen/exprs/parallelism.yo`). Any `__yo_worker_*` call marks the
  program as using the parallelism runtime, so a pool created and dropped
  without a task still links.
- **Waking.** All of a pool's queues and flags sit under one mutex; each worker
  sleeps on its own condition variable. A shared submission wakes one sleeping
  worker; a pinned one wakes its worker. A worker that finishes a task checks
  both queues before it sleeps, so no submission is missed when every worker
  is busy.
- **Shutdown from one of the pool's own tasks** (a task drops the last
  `Arc(ThreadPool)`, or calls `shutdown`) cannot join the thread it runs on.
  It closes the pool and returns; the workers run what was queued and exit.
  If it was the drop, the workers are detached and the last one to exit frees
  the handle.
- **A pool with no worker** (thread creation fails: standalone WASI) runs
  every `spawn` and every `spawn_on` inline. With workers, `spawn_on(pool, i,
  cb)` panics unless `i < worker_count()`. A creation failure after some
  workers started keeps the ones that started: `worker_count()` reports them.
- **Exit does not wait** for a pool that is never dropped (a module global):
  `tests/cli-cases/pool-task-blocked-at-exit-does-not-hang` holds its pool in
  one.
- **Tests:** `tests/thread-pool-shared-queue.test.yo` (the issue's repro, the
  exact worker count, `spawn_on`/`worker_id`, a pinned task waiting for its
  busy worker while the shared queue runs elsewhere, `Drop` drains, the drop
  of the last `Arc(ThreadPool)` inside a task).
