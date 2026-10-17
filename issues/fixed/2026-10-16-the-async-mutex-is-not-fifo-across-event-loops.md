# The async `Mutex` is not FIFO across event loops

**Severity:** S3 — a task waiting on another thread's loop can lose the lock to a later same-loop waiter, so the documented FIFO order holds only among one loop's tasks.

**Status:** fixed 2026-10-17 (#PRNUM2) with the strict hand-off below. Found
2026-10-16 by the pre-merge review of #1380, which documented the weaker
guarantee until this fix.

## Symptom

`std/async/mutex.yo` queues waiters in arrival order and `unlock` wakes the
front one. For a waiter on the same loop, `Waker.is_woken()` reports the wake
at once, so `unlock` stops there. For a waiter on another thread's loop, the
wake is only posted to that loop, `is_woken()` stays false, and `unlock` keeps
going and wakes the next waiter as well (the loop exists so that a cancelled
waiter, which refuses its wake, does not strand the queue). Each woken task
re-checks the lock, so whichever runs first takes it. A same-loop waiter that
queued after a foreign one usually re-checks first, and under sustained
contention the foreign waiter can starve.

## What a fix needs

A strict hand-off: `unlock` leaves `_locked` set and marks the lock as handed
to the front waiter, which then owns it without a re-check. Two things make it
more than a one-line change:

- a cancelled waiter must hand the lock on, not drop it, which needs a hook on
  the park's cancellation path (today a cancelled waiter is only detected by
  `is_woken()` refusing the wake, and that answer is unavailable cross-thread);
- `try_lock` from a third task must observe the handed lock as held.

## Recommendation

Keep the weaker guarantee documented until a cross-thread contention test
shows the starvation matters in practice; then build the hand-off above.
(Superseded: the maintainer asked for the hand-off on 2026-10-17.)

## Fix

`std/async/mutex.yo` hands the lock over. Each queued waiter carries a ticket
and the thread its loop runs on. `unlock` takes the front waiter, wakes it,
and leaves `_locked` set with `_handed` = its ticket; the waiter `take`s the
lock when it resumes, without a re-check, so a later waiter or a third task's
`try_lock` sees the lock held and cannot take it first. `waiter_count` no
longer counts the waiter being handed the lock.

Cancellation, the two points above:

- a same-loop waiter that refuses the wake (`is_woken()` is false and its
  thread is the unlocker's) was cancelled, and is skipped as before. A waiter
  on another thread's loop gets the lock whatever `is_woken()` says, since
  the answer is not available yet;
- the hook on the cancellation path is a `_Claim` that `lock`'s future keeps
  across its park. Its `Drop` runs when the future is released with its
  cancelled task, and either takes the waiter out of the queue or, when the
  lock was handed to it, hands the lock on to the next waiter. A woken waiter
  aborted before it resumed (which, before this fix, left the lock free with
  the remaining waiters parked on it) is covered the same way. The hook runs
  when the task's last reference goes, as every aborted task's locals are
  dropped; until then the lock stays with the dead waiter.

The lock state and its guard moved into an `Arc(_Core)` that each claim
holds a handle on: an aborted task releases its captures before its pending
futures, so a claim can outlive the `Mutex` it came from.

Tests (`tests/async/mutex.test.yo`): "the lock is handed FIFO across loops,
ahead of a later same-loop waiter" (a waiter on a spawned thread's loop queues
first and a main-loop task second, gated on `waiter_count` rather than on
timing; right after `unlock` the lock must still be held and `try_lock`
must refuse, which failed before, and the foreign waiter must run first); "a
waiter cancelled on another thread's loop leaves the queue" (before: the dead
waiter stayed queued until the next `unlock`); and "a waiter cancelled after
the lock was handed to it passes the lock on" (before: the second waiter
stayed parked on a free lock and timed out).
