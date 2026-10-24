# The debug allocator judges blocks that a still-running thread owns

**Severity:** S2. A correct program that starts a thread fails `--allocator debug`'s leak check with exit status 23 whenever one of its threads is still running when the exit report runs. Detached `Thread`s and `ThreadPool` workers are both affected, with the cycle collector `auto` or `off`. A test-suite run under `--allocator debug` (W6a's corpus measurement) would flake on every pool test.

**Status:** FIXED 2026-10-24 (`feat/z11-debug-allocator`, before the allocator merged). **Found:** 2026-10-23 through `tests/send_sync.test.yo` (filed then as a cycle-collector bug), and re-scoped on 2026-10-24 by the adversarial review of the branch (findings Z11-R1 and F1).

## Symptom

A detached thread that is still sleeping when `main` returns:

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
{ Thread } :: import("std/thread");
{ sleep_blocking } :: import("std/time/sleep");
{ Duration } :: import("std/time/duration");
main :: (fn() -> unit)({
  _t := Thread(unit).spawn(io => {
    msg := String.from("a string allocated on the thread, longer than any small buffer");
    sleep_blocking(Duration.from_millis(i64(2000)));
    println(&msg);
  });
  sleep_blocking(Duration.from_millis(i64(200)));
  println("main returns without joining");
});
export(main);
```

```text
debug allocator: leak check failed: 14 blocks / 463 bytes leaked after main returned (exit status 23)
```

The run exited 23 under both `--cycle-collector auto` and `off`. The same program under `--allocator system --sanitize address` with `detect_leaks=1` exits 0, because LeakSanitizer scans live threads' stacks.

The pool form fails intermittently. Eight tasks on `ThreadPool.new(4)`, then `pool.join_all()`, then return. Under load (8 parallel loops of 100 runs) this failed 7/800 times with `auto` and 5/800 with `off`. `tests/send_sync.test.yo` "a move-only capture crosses spawn(pool, …) and disposes once" failed 1 run in 15 the same way. There, the leaked block was the pool worker's GC state, which `__yo_cleanup_thread_gc` unlinks from `__yo_all_thread_gcs` before it frees it.

## Root cause

The exit report's only roots were module globals and two registered runtime statics. A block that only a running thread's stack (or a capture it has not dropped yet) reaches looks leaked. Threads are still running at report time in two cases:

- **Detached threads.** `Thread`'s handle drop detaches, and nothing waits for the thread.
- **Pool workers.** The atexit pool shutdown signals the workers and returns without joining (by design, `issues/fixed/worker-pool-atexit-shutdown-joins-workers-blocked-in-a-task.md`). In `std/thread.yo`'s `spawn`, the relay closure calls `tasks.done()` before the worker drops the closure and its `tasks` capture. So `join_all` returns, and `main` returns, while a worker still holds the last references. The worker then finishes against a report that holds the allocator lock.

The cycle collector is not the cause: its GC state is just one of the blocks a finishing worker frees late.

## Fix

The report now waits for threads before it judges:

- **Thread count.** The parallelism runtime counts the program's threads under `--allocator debug` (`src/codegen/parallelism/runtime.yo`). `__yo_debug_alloc_thread_enter` runs before `__yo_raw_thread_create`, and is undone if creation fails. `__yo_debug_alloc_thread_leave` is the thread's last act, after `__yo_cleanup_thread_gc`.
- **Bounded wait.** Before it takes its lock, the exit report waits up to one second for that count to reach zero (`src/codegen/c/allocator_debug.yo`, `__yo_dbg_wait_threads`). By then the pool's atexit shutdown has already told idle workers to stop.
- **No verdict while a thread runs.** If a thread is still running after the wait, the report lists the live blocks and prints `N threads of the program were still running 1000 ms after main returned, so the live blocks are not judged`, as it already did for an `exit()`.

The report also counts runtime-reached blocks as `still reachable from module globals or runtime state`, since the worker array and the GC-state list are roots too.

Regression tests are in `tests/debug_allocator.test.yo`:

- **"a detached thread that finishes after main returns is waited for, not reported".** Deterministic: before the fix it exited 23 every time, because the thread's closure and string were live at report time.
- **"a thread still running past the wait leaves the live blocks unjudged".**
- **"a pool's finished tasks are judged after its workers exit".**

`tests/send_sync.test.yo` under `--allocator debug` now passes with the collector on.
