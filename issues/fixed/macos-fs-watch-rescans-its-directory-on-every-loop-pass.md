# macOS: an fs watch rescans its directory on every loop pass

**Status: FIXED (2026-09-28).** Listed as an open macOS item after #982.
**Measured** on macOS 26.6 (M4), develop at af62bdb28 against this fix.

## Symptom

With a `std/fs/watch` (or `std/sys/events` fs-event handle) active on a
directory, every turn of the event loop re-read the whole directory. The test
below makes 20,000 loop passes (`yield`s) under a watch of a 300-entry
directory:

| runtime | CPU time |
| --- | ---: |
| develop (af62bdb28) | **25,723 ms** (1.3 ms per pass) |
| this fix | 3 ms |

A busy server with one config-directory watch spent most of its CPU in
`opendir`/`readdir`/`stat`.

The same design had three more costs:

- Every watch owned a private kqueue, and every tick polled it with its own
  `kevent()`.
- Every poll handle cost a `poll()` per tick.
- Because watches were only serviced by ticks, the loop's wait was capped at
  100 ms, and a loop with only watches slept in 10 ms `nanosleep`s. An idle
  process with a watch therefore woke 100 times a second.

## Root cause

`__yo_poll_and_fs_event_tick` (macOS) called
`__yo_fs_event_detect_snapshot_changes` for every active handle on every tick,
and a directory's snapshot diff is an `opendir`, a `readdir` pass and a `stat`
per entry. Nothing gated it on whether anything had changed.

## Fix

- **One watch kqueue per thread**, registered level-triggered in the loop's
  kqueue. fs-event handles add their `O_EVTONLY` descriptor to it
  (`EVFILT_VNODE`, `EV_CLEAR`), and poll handles add `EVFILT_READ`/`WRITE`
  (`EVFILT_EXCEPT` for `POLLPRI`). A ready watch ends a blocked wait like any
  operation. The tick drains the watch kqueue only when the loop's `kevent()`
  reported it.
- **Directory rescans are event-driven, plus a bounded periodic scan.** A
  directory's vnode reports entries created, removed and renamed, but not a
  write into an existing entry, which only the diff sees (the "fs_event
  detects file modification" test). So a directory handle rescans on every
  vnode event, and between events at most every 50 ms. The interval stretches
  to 20× the last scan's cost, so a huge directory takes at most ~5% of a
  core. A file handle is serviced only on its vnode events. A path that has
  vanished is looked for at the same interval and re-watched when it returns,
  and so is a file replaced by a rename-over.
- **Poll handles** are polled only when the watch set reported them. A
  descriptor kqueue cannot watch with `poll(2)`'s meaning (a regular file,
  which `poll` reports always ready but kqueue only before EOF; a directory; a
  device kqueue refuses) keeps the old per-tick `poll()`, and bounds the wait
  to 10 ms while such a handle is active, like Linux's `__yo_watch_needs_polling`.
- The loop's wait is bounded only by the next timer and the next watch
  deadline (`__yo_watch_next_due_ns`), with no fixed 100 ms / 10 ms tick.

## Test

`tests/fs/watch.test.yo`: "a directory watch does not rescan the directory on
every loop pass" asserts under 1,500 ms of CPU. It fails on develop (25,723 ms)
and passes here (3 ms). The existing watch tests (creation, modification,
deletion, a deleted directory reported once, `next(io)` parking, poll handles
firing while the loop is blocked) pass unchanged.
