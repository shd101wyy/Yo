# Windows: the worker pool's mutex is lazily initialized with a plain check-then-init

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-20;
raised by the runtime sub-audit, verified by reading).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 6). Was: OPEN. **Data race, Windows only** (`*-windows-msvc`, `*-windows-gnu`).
**Where:** `src/codegen/parallelism/runtime.yo` ~41-52 (`__yo_worker_init_mutex`), called at the
top of `__yo_worker_spawn`, `__yo_worker_set_num_threads`, `__yo_worker_get_num_threads`.

## Mechanism

```c
static volatile int __yo_worker_pool_mutex_initialized = 0;
static void __yo_worker_init_mutex(void) {
  if (!__yo_worker_pool_mutex_initialized) {
    InitializeCriticalSection(&__yo_worker_pool_mutex);
    __yo_worker_pool_mutex_initialized = 1;
  }
}
```

Two threads making their first pool submission concurrently (a `Thread.spawn`ed thread may call
`spawn(pool, …)`; `tests/thread_pool.test.yo` "ThreadPool shared with another OS thread that
submits into it" is the shape) both see 0, both initialize the section, and both proceed into
`__yo_worker_pool_init` with no mutual exclusion — a double `InitializeCriticalSection` is UB,
and the pool array can be allocated twice. POSIX uses `PTHREAD_MUTEX_INITIALIZER` and is fine.

## Fix direction

The GC runtime's own Windows once-init (`src/codegen/functions/gc_runtime.yo` ~586-602,
`InterlockedCompareExchange` on a started flag + spin on a done flag) is the pattern; or
`InitOnceExecuteOnce`. Test: the existing "shared with another OS thread" pool test is the
regression, once the Windows CI legs run `tests/thread_pool.test.yo` under a race-detecting
build (there is no TSan on MSVC; the test's assertion on the task count is what catches a
double init).

## Fix (2026-09-26)

`__yo_worker_init_mutex` (`src/codegen/parallelism/runtime.yo`) is a once-init on
`InterlockedCompareExchange` (a started flag, a done flag, the losers spin until the winner
publishes) — the GC runtime's pattern. Gate: the Windows legs' `tests/thread_pool.test.yo`
("shared with another OS thread" submits concurrently) and the local `zig cc -target
x86_64-windows-gnu` compile of the emitted runtime.
