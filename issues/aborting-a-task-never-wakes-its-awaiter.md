# `JoinHandle.abort()` never wakes a task that is awaiting the aborted task (hang)

**Status: OPEN.** Found 2026-09-28 by the async state-machine audit (`plans/ASYNC_STATE_MACHINE_GENERATION.md`). Reproduces on the v0.2.45 seed and on a tree build of develop `af62bdb28`.

## Symptom

`issues/repros/aborting-a-task-never-wakes-its-awaiter.yo`: `f` is
spawned, and task `a` awaits it. `main` then calls `hf.abort()`.

```
a: awaiting f
main: aborted f
<hang; rc=124>
```

`issues/repros/aborting-a-task-never-wakes-its-awaiter-nested.yo` shows the
same thing when `f` is suspended on a nested state machine rather than on a
sleep.

Expected: `a`'s await observes the abort. Per the docs, awaiting an aborted
future panics, and `ha.await(io)` then yields `.None`. Either way it
terminates.

## Root cause

None of the three abort paths fires the aborted future's continuation:

- `__yo_join_handle_abort_raw` (`src/codegen/async/runtime_core.yo`) marks
  the task `-2` and calls `cancel_pending_fn`.
- `generate_async_block_cancel_pending_function`
  (`src/codegen/async/state_machine.yo`) releases the I/O slot and the task
  reference, then returns.
- The resume function's `if (sm->state == -2)` entry guard releases the
  slots and returns.

Only the effect-unwind transition (`emit_async_future_escape`) spawns the
continuation. So a waiter parked on an externally aborted future is never
resumed.

## Fix direction

Abort must be a completion: set `-2`, wake every waiter (see
`issues/two-tasks-awaiting-one-pending-future-lose-the-first-waiter.md`),
then release. Do it in one runtime helper that all three paths call, so
the paths cannot drift apart again.
