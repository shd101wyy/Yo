# Abort does not reach a nested future: the aborted task's inner future keeps running (stolen message, mutex held forever, leaks)

**Status: OPEN.** Found 2026-09-28 by the async state-machine audit (`plans/backlog/ASYNC_STATE_MACHINE_GENERATION.md`). Reproduces on the v0.2.45 seed and on a tree build of develop `af62bdb28`.

## Symptom

- `issues/repros/abort-orphan-recv-steals-message.yo`: a receiver task is
  timed out (`timeout(h, 5ms)`), then a live receiver waits and `42` is
  sent. Output: `live receiver got it: false (expect true)  buffered=0`. The
  aborted task's orphaned `recv` future consumed the message.
- `issues/repros/abort-orphan-lock-holds-mutex-forever.yo`: a task blocked
  in `Mutex.lock` is timed out. Its orphaned `lock` future later acquires
  the mutex and never releases it: `after c: locked=true waiters=0`, then
  `d acquired: false`. Every later locker deadlocks.
- `issues/repros/abort-timeout-recv-leaks-task.yo`: each `timeout()` of a
  task blocked on `Channel.recv` leaks about 900 B (the task state machine,
  the recv/park/waker futures and its RC locals). `disposed=0 (expect 3)`.

## Root cause

Cancellation covers only a DIRECT I/O slot. `_io_await_future_slots`
(`src/codegen/async/state_machine.yo`) deliberately excludes an
`await_future_N` that holds another state machine ("that task's business"),
and `__yo_join_handle_abort_raw` does not recurse. An aborted task
suspended in `io.await(ch.recv(io), io)` therefore leaves the `recv` state
machine alive and registered as the channel's waiter. The waiter consumes
the next message, or takes the lock, on behalf of a task that will never
run again.

## Fix direction

Structured cancellation: aborting a task cancels the future it is suspended
on, recursively. The suspended-on future is the one the task exclusively
owns in its `await_future_N` slot, or a named local future it started. An
SM future gets a real `cancel_pending_fn`, which marks itself aborted,
cancels its own pending child, runs its per-state drops, and wakes its
waiters. std's `Channel`/`Mutex` waiters must deregister on cancel.
Regression tests: all three repros.
