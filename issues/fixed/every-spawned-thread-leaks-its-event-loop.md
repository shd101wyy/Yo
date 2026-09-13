# Every spawned thread leaks its event loop — an io_uring ring on Linux, a kqueue fd everywhere else

**Found**: 2026-09-13, by the `spawn_blocking` regression test added in PR #667.
**Fixed**: same day, in `src/codegen/parallelism/runtime.yo`. **Class**: kernel
resource leak, one per `Thread.spawn` in any program that uses async, for the
life of the process.

## Symptom

CI, `test (ubuntu-latest)`, a test that spawns 400 threads over its run:

```
✗ repeated pairs of spawn_blocking do not corrupt the wake inbox
  Test failed with exit code 256
[Yo] io_uring_queue_init failed: Cannot allocate memory
```

On macOS the same leak is a file descriptor rather than locked memory, and the
program dies with `panic: kqueue() failed: Too many open files`, or — more
confusingly — with `spawn_blocking: the worker thread produced no value (it
unwound)`, because the worker panicked before it could send.

## Mechanism

`__yo_thread_entry` (and `__yo_worker_thread_entry`) call
`__yo_async_scheduler_init()` on entry and `__yo_async_wait_all()` on exit when
the program uses async. `__yo_async_wait_all` opens the loop:

```c
static void __yo_async_wait_all(void) {
  if (!__yo_async_scheduler_initialized) return;
  __yo_io_init();          /* <- creates this thread's ring / kqueue + notify fd */
  ...
}
```

but nothing ever closes it. `__yo_io_cleanup()` had exactly ONE caller in the
whole runtime — the async-main driver in `runtime_core.yo` — and that runs on
the main loop thread, which never sees a spawned thread's loop. So each spawned
thread creates a kernel event-loop object and a notify descriptor and takes them
to its grave.

It went unnoticed because nothing created threads in bulk. `spawn_blocking`
makes a thread per call, which is what turned a slow leak into a hard failure.

## Measurement

Probe the fd that `kqueue()` returns on each thread, 40 sequential
`spawn_blocking` calls (`issues/repros/two-spawn-blocking-in-flight.yo` is the
sibling repro; this one is 40 rounds of one):

| build | kqueue fds handed out |
| --- | --- |
| control | `3, 4, 5, … 40, 41, 42` — **one new fd per thread, monotonic** |
| fixed | `3, 4, 3, 4, … 3, 4, 3` — **reused**; at most the main loop plus one worker |

That is the whole result. An earlier attempt to measure this as a THRESHOLD
("at what thread count does each variant fail under `ulimit -n 256`") produced
non-monotone nonsense — 3/3 failures at N=200 and 1/3 at N=400 — because near
the fd ceiling the variance is dominated by how many detached workers happen to
be alive at once, not by the leak. The direct probe answers in one run what the
threshold sweep could not answer at all.

## Fix

Release the loop where it was acquired: at THREAD exit, after
`__yo_async_wait_all()`, in both thread entry points. For the worker pool the
release is deliberately at thread teardown rather than beside the per-task
`__yo_async_wait_all()` — a pool thread runs many tasks, and tearing the ring
down after each one would rebuild it for the next. The leak is per-thread, so
the release belongs at thread teardown.

## Still open, and deliberately not claimed as fixed

At very high spawn rates against a low fd limit (2000 sequential
`spawn_blocking` under `ulimit -n 1024`) the program still fails. With fd reuse
proven above, that is NOT this leak; the remaining pressure is detached workers
being alive simultaneously — `spawn_blocking` detaches and never joins, by
design. Whether `spawn_blocking` should be pooled the way Rust's is
(`tokio::task::spawn_blocking` uses a bounded blocking pool for exactly this
reason) is a design question, not a bug fix, and it is not answered here.
