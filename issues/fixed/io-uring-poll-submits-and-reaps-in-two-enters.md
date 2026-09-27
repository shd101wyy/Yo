# io_uring: every op that completes at issue costs two `io_uring_enter` calls

**Status: FIXED (2026-09-27).** Found from the first stock-Linux run of the I/O
budget and bench jobs (PR #964, run 36334993270, `ubuntu-latest` x86_64).

**Provenance:**
- The syscall count is **measured**: budget A's ring total was 1,601 for 200
  rounds of 4 ops, i.e. 8 per round and 2 per op. The epoll fallback's total
  was 800.
- The cause is **read from the code**.
- The after-fix count is the budget itself, now 6 per round, which CI enforces
  on both backends.

## Symptom

On stock Linux the ring lost to the epoll fallback on the inline ping-pong:

| benchmark | uring ops/s | epoll ops/s | epoll/uring |
| --------- | ----------: | ----------: | ----------: |
| pingpong  |     561,679 |     976,801 |       1.739 |
| parked    |     534,295 |     402,799 |       0.754 |

The ping-pong is a socketpair on which every op can complete at once.

## Root cause

`__yo_io_poll` (`src/codegen/async/runtime_io_linux.yo`) made two kernel entries:
1. `__yo_io_flush_sq()`, a plain submit (`flags == 0`);
2. `__yo_uring_getevents()`, the zero-timeout GETEVENTS entry that
   `DEFER_TASKRUN` needs before completions become visible
   (`issues/fixed/io-uring-defer-taskrun-poll-never-enters-kernel.md`).

A single `io_uring_enter(to_submit, 0, GETEVENTS)` does both. The blocking wait
(`__yo_io_wait`) already combined them; the poll did not.

## Fix

- When SQEs are queued, the poll makes one `__yo_uring_submit_and_wait(ring, 0)`
  call. That enter does not block.
- Otherwise it keeps the bare GETEVENTS probe.
- The deferred-SQE bookkeeping, which had been copied into flush and wait, is one
  helper: `__yo_io_account_submitted`.
- EINTR retry is sound because the kernel returns the submitted count, not
  `-EINTR`, once anything was submitted.

## Regression tests

- `scripts/bench/io_budget.yo` budget A is 6 per round, down from 10; the old
  shape's 8 fails it. It runs on both backends in the `io-budgets` CI job.
- `tests/internal/uring_runtime.test.yo` pins the combined enter in the poll.
