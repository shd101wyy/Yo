# Tasks still pending or queued at thread exit are never released

**Severity:** S3. A program or test body that returns while spawned tasks are still pending, or while an aborted task's resume is still on the ready queue, leaks those tasks. Only a leak checker sees it: the thread is exiting.

**Status: OPEN.** Found 2026-10-01 while diagnosing the `tests/async/while_await_in_match_arm.test.yo` leaks. The v0.2.46 seed shows it as well.

## Symptom

- A plain `main` that spawns a task sleeping 200 ms and returns at once leaks 88 + 160 B under valgrind: the task and its timer future.
- Separately, a task aborted while its wake was already queued (`__yo_async_enqueue_continuation` ← `__yo_waker_wake_local` ← `__yo_async_drain_yields`) leaves a continuation node and the task on the ready list at exit: 24 direct + 296 indirect B.

## What is known

The thread-exit hook (`__yo_async_free_cont_pool`, `src/codegen/async/runtime_core.yo`) releases the continuation free list, the state-machine pools, the pending yields, the backend (`__yo_io_cleanup`, which cancels timers) and the abort registry. It does not walk the ready queue, or tasks that are merely pending on I/O or a timer.

## Recommendation

At thread exit, abort every task still reachable from the loop's ready queue and waiter lists, then drain the ready queue. The pending timers are already cancelled by `__yo_io_cleanup`. That releases each task through its ordinary abort path, and never runs user code after `main` returned: the aborted-entry guard returns at once. Until then, tests that `race` tasks abort their losers (`tests/async/while_await_in_match_arm.test.yo`).
