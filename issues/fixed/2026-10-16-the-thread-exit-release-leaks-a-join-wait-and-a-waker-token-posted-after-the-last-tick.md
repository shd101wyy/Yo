# The thread-exit release leaks a join wait and a waker token posted after the last tick

**Severity:** S3 — a bounded leak at thread exit (one 64-byte join wait per `timeout`/`race`-style wait still queued, one waker token and its park future per release still on the inbox); it made 19 leak verdicts fail and hid real leaks behind them.

**Found:** 2026-10-16, sorting the leak verdicts that remained in `tests/async/combinators.test.yo` (16), `tests/async/channel.test.yo` (1) and `tests/cross_thread_wake.test.yo` (2) once the capture leaks were fixed. Reproduces on develop `b0c4630d3`.

## Reproducers

`timeout` over a task that finishes first:

```yo
{ timeout } :: import("std/async");
{ Duration } :: import("std/time/duration");
main :: (fn(io : Io) -> unit)({
  h := io.spawn(io.async((io : Io) => i32(1)), io);
  _r := io.await(timeout(h, Duration.from_millis(i64(5000)), io), io);
});
export(main);
```

`SUMMARY: AddressSanitizer: 64 byte(s) leaked in 1 allocation(s)`, allocated by `__yo_join_wait_new`. Two more `io.await(yield(io), io)` before the end make it go away: the leak is work still queued when the thread exits.

A waker whose last handle is dropped on a worker after the owner's last tick (`tests/async/exit_release.test.yo`, the second test): the token and its park future leak.

## Root cause

A test body or a plain `main(io)` is driven by synchronous awaits, so no loop driver tears it down; `__yo_async_thread_exit_release` (`src/codegen/async/runtime_core.yo`) is the teardown. It handled tasks only:

- **A join wait's waiter entry.** `timeout` waits on the task and on a deadline task through one join wait. The task finished first and completed the wait; then the deadline task was aborted, which queued its waiter entry (`__yo_join_wait_fire`, payload: the wait). The drain aborts each queued payload and resumes it only if the abort marked it Aborted, and a Completed wait stays Completed, so the entry never ran and its reference to the wait was never dropped.
- **The cross-thread inbox.** A loop driver ends with `__yo_async_loop_quiesce()`, which drains the inbox; the thread-exit release did not, so a release posted after the last tick kept its token and the park future it references.

## Fix

`__yo_async_thread_exit_release` quiesces the inbox first, as a loop driver does, and runs a queued `__yo_join_wait_fire` entry whatever state its wait is in (the fire is runtime code: a wake that is a no-op on a terminal park, then the release).

Test: `tests/async/exit_release.test.yo` (`pragma(Pragma.NeedsLeakVerdict)`: the leaked memory is runtime state no Yo value owns, so the leak verdict is the only oracle), both tests fail on the build before this fix. With leak verdicts on, `tests/async/combinators.test.yo` and the `cross_thread_wake` and `channel` stragglers are leak-clean; `leak-verdict.yml` now runs them.
