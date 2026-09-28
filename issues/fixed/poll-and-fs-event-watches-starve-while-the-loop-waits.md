# Linux: poll and fs-event watches are not serviced while the loop waits, and `Watcher.next` spins a core

**Status: FIXED (2026-09-28).** Found by reading `runtime_io_linux.yo`,
`runtime_io_common.yo` and `std/fs/watch.yo` during the 2026-09-28 Linux
async-runtime audit; reproduced by the regression tests below.

## Symptom

Three faces of one design gap. The poll and fs-event handles
(`std/sys/events`, and `std/fs/watch`'s `Watcher` above them) are TICKED:
`__yo_poll_and_fs_event_tick` polls each started handle (`poll(2)` /
an inotify `read`) from `__yo_io_poll`. Nothing made a watched descriptor
able to end a blocked wait.

1. **Starvation while I/O is in flight.** `__yo_io_wait` blocked in
   `io_uring_enter` (or `epoll_wait(-1)`) until some OPERATION completed. A
   descriptor that became ready during that wait was not noticed until then:
   a pipe made readable 50 ms into a 1 s sleep fired its poll callback after
   the sleep, on both backends.
2. **10 ms polling with nothing else pending.** A loop whose only pending work
   was watches slept 10 ms, ticked, and slept again: up to 10 ms of latency
   and 100 wakeups a second.
3. **`Watcher.next` spins.** `next` re-`yield`ed in a loop until an event was
   queued, so the waiting task was always runnable and the loop never
   blocked: 300 ms of waiting cost ~300 ms of CPU.

## Reproducers

- `tests/sys/poll.test.yo`, "a poll watch fires while the loop is blocked on
  an unrelated timer" (and its epoll-fallback twin): a thread writes to a pipe
  50 ms in while the loop sleeps 1,000 ms; the callback must fire before
  700 ms. Before: fails on both backends (the callback ran after the sleep).
- `tests/fs/watch.test.yo`, "a task waiting in next(io) does not spin the
  CPU": a task creates a file 300 ms after `next` starts waiting; the
  process's CPU time over the wait must stay under 150 ms.

## Fix

- **The watch set** (`runtime_io_linux.yo`): a per-thread epoll instance
  holding every watched descriptor. `__yo_io_watch_set` is called when a poll
  handle starts or stops (the union of the handles on that fd) and when an
  fs-event handle starts or stops (its inotify fd). Before a blocking wait,
  `__yo_io_arm_watches` makes the set able to end it: the ring arms a
  one-shot `POLL_ADD` on it (`__YO_IO_WATCH_UD`), the epoll backend adds it
  to its own set. The ticks themselves are unchanged. A descriptor epoll
  refuses (a regular file, `EPERM`) keeps the old 10 ms polling wait; the
  DEGRADED rung does too.
- **`Watcher.next` parks** on a `Waker` (`std/async/waker`) that the event
  callback, and `close`, fire.
- The loop drivers' "only watches pending → nanosleep 10 ms" branches are
  gone.
