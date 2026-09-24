# The worker pool's `atexit` shutdown joins every worker unconditionally, so `exit()` hangs on a blocked task

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-23;
raised by the runtime sub-audit, verified by reading).
**Status:** OPEN. **Liveness at process exit; a leak in dead code.**
**Where:** `src/codegen/parallelism/runtime.yo` ~380-410 (`__yo_worker_pool_shutdown`,
registered with `atexit` in `__yo_worker_pool_init`).

## Mechanism

Shutdown sets each worker's `shutdown` flag under its mutex, signals, then
`__yo_raw_thread_join`s every running worker. A worker INSIDE `task->fn` — blocked in a channel
`recv` that no one will feed, or in any blocking call — never observes the flag, so a `main`
that returns (or any `exit()`) never terminates the process. If `exit()` is called from inside a
pool task, the handler joins the calling thread itself (`pthread_join` of self: `EDEADLK` or a
hang). Rust's global thread pools detach at exit for this reason; `Thread` handles in Yo detach
on drop for the same reason (`issues/fixed/thread-join-was-re-callable-and-handles-leaked.md`).

The "free remaining queued tasks" loop frees `task->closure` with `__yo_free` without running the
spawn wrapper's drops (every captured RC value leaks) — but it is effectively unreachable: a
worker only exits when its queue is empty, and a slot with `running == 0` never gets a task.

## Fix direction

Do not join at exit: set `shutdown`, signal, and return — workers idle in `cond_wait` exit
promptly, a worker mid-task is reclaimed by process teardown exactly like a detached `Thread`.
`ThreadPool.shutdown` / `join_all` remain the explicit "wait for my work" API. Delete the dead
free loop, or make it run the wrapper (which drops and frees) if it is kept. Test: a pool task
that blocks on a channel forever while `main` returns; the test's process must exit (today it
hangs, which is why no such test exists).
