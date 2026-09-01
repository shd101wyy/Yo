# `sleep(0)` never completes on Linux — timerfd_settime(0) DISARMS the timer

**Status: FIXED 2026-09-01.** Found reviewing #373's `yield` park while
evaluating `sleep(u64(0))` as a granularity-free park. Fixed by clamping the
timerfd arm value to 1 ns (`__yo_async_sleep_start`,
`src/codegen/async/runtime_io_common.yo`); pinned by "Test zero-length sleep
completes" in `tests/sys/timer.test.yo` (plain-context await + in-task await).

## What

`__yo_async_sleep_start` on the io_uring runtime
(`src/codegen/async/runtime_io_common.yo`, the timerfd variant) converts the
requested milliseconds straight into `itimerspec.it_value`. For
`milliseconds == 0` that is `{0, 0}` — and POSIX defines
`timerfd_settime` with a zero `it_value` as **disarming** the timer. The
io_uring read of the timerfd then never completes: `sleep(0)` (and
`std/time/sleep` with a zero `Duration`) parks its awaiter FOREVER on Linux.

macOS (kqueue `EVFILT_TIMER`, 0 µs oneshot fires on the next kevent wait),
Windows (`__yo_win_timer_add` due=now fires on the next
`timer_process_due`), and wasm (same due-list shape) all complete a 0-length
sleep on the next loop turn — Linux is the odd one out.

## Fix

Clamp the timerfd arm value to 1 ns when the requested duration is zero
(`its.it_value.tv_nsec = 1`), keeping "fires on the next loop turn"
semantics. Add a `sleep(u64(0))` round-trip to `tests/sys/timer.test.yo`
(awaited from a plain context AND inside a task) so all four runtimes stay
pinned.

## Why it matters beyond the edge case

A granularity-free `yield` park (`sleep(0)` instead of the current 1 ms —
Windows' GetTickCount64 wheel makes every 1 ms park cost ~15.6 ms) is blocked
on exactly this defect. The eventual clean design is a timer-free yield that
enqueues its own completion on the ready queue, but that needs a new runtime
extern, i.e. it is seed-gated.
