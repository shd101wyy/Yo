# Tasks still pending or queued at thread exit are never released

**Severity:** S3. A program or test body that returns while spawned tasks are still pending, or while an aborted task's resume is still on the ready queue, leaks those tasks. Only a leak checker sees it: the thread is exiting.

**Status: FIXED (2026-10-03).** Found 2026-10-01 while diagnosing the `tests/async/while_await_in_match_arm.test.yo` leaks. The v0.2.46 seed shows it as well.

## Symptom

- A plain `main` that spawns a task sleeping 200 ms and returns at once leaks 88 + 160 B under valgrind: the task and its timer future.
- Separately, a task aborted while its wake was already queued (`__yo_async_enqueue_continuation` ← `__yo_waker_wake_local` ← `__yo_async_drain_yields`) leaves a continuation node and the task on the ready list at exit: 24 direct + 296 indirect B.

## What is known

The thread-exit hook (`__yo_async_free_cont_pool`, `src/codegen/async/runtime_core.yo`) releases the continuation free list, the state-machine pools, the pending yields, the backend (`__yo_io_cleanup`, which cancels timers) and the abort registry. It does not walk the ready queue, or tasks that are merely pending on I/O or a timer.

## Recommendation

At thread exit, abort every task still reachable from the loop's ready queue and waiter lists, then drain the ready queue. The pending timers are already cancelled by `__yo_io_cleanup`. That releases each task through its ordinary abort path, and never runs user code after `main` returned: the aborted-entry guard returns at once. Until then, tests that `race` tasks abort their losers (`tests/async/while_await_in_match_arm.test.yo`).

## Fixed

**2026-10-03, branch `s3/batch-0-fixes`.** Root cause: the thread-exit hook freed the pools but never aborted the tasks themselves — nothing walked the ready queue `__yo_thread_async_queue`, and each backend's teardown marked pending futures terminal (state −1) without aborting the task parked on them, so the task, the future its `__yo_await_slot` still referenced, and its captures stayed allocated forever; the aborted-with-wake-queued variant never ran its release guard because the queue was never drained. The fix is two pieces in the emitted runtime: (1) every backend teardown now first aborts the tasks still parked on each pending future through their ordinary abort path — `__yo_io_teardown_abort_waiters` in `src/codegen/async/runtime_core.yo`, which takes its own reference across the abort, aborts each waiter task (releasing it at once when the I/O-cancel path applies), and fails a still-pending future as aborted with its waiters taken so an already-aborted task is enqueued for the drain — wired into the timer registries of all four platforms, Linux's deferred-SQE ring, in-flight fd buckets and epoll table, and macOS's kqueue pending-op table (each walks a snapshot, since an abort can cancel and free registrations out from under the walk); (2) the hook itself is now `__yo_async_thread_exit_release` — backend cleanup first, then a ready-queue drain that aborts each queued task and runs its resume so only the aborted-entry guard executes (no user code after `main` returned), then the pool free. `__yo_cleanup_thread_gc` (full cyclic-GC runtime, `src/codegen/functions/gc_runtime.yo`) now calls the hook BEFORE its dispose/free passes, so the release drops task captures while they are still alive instead of after the GC freed them. Test: `tests/internal/async_thread_exit_release.test.yo` pins the emitted runtime shape (red before the source change, green after — CI runs with `detect_leaks=0`, so no language test can observe an exit-time leak; the pin is the gate, the technique of `tests/internal/uring_runtime.test.yo`). Runtime-verified on Windows with a malloc-counting harness over the emitted C: the repro (spawn a 200 ms sleeping task, return without awaiting) leaked the 88 B task + 64 B timer future at exit before the fix and reports 0 outstanding after; the awaited control reports 0 both ways. The Linux cross-emission syntax-checks identically before and after (`zig cc -fsyntax-only`). Docs: `docs/en-US/ASYNC_AWAIT.md` and `docs/zh-CN/ASYNC_AWAIT.md` now state the thread-exit release contract beside the detach paragraph.
