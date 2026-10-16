# The async `Mutex` is not FIFO across event loops

**Severity:** S3 — a task waiting on another thread's loop can lose the lock to a later same-loop waiter, so the documented FIFO order holds only among one loop's tasks.

**Status:** open, found 2026-10-16 by the pre-merge review of #1380. The
module doc now states the real guarantee and cites this doc.

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
