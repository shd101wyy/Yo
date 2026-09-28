# io_uring: a tick that starts more than 1,024 operations fails the rest with `-EAGAIN`

**Status: FIXED (2026-09-28).** Found by reading `runtime_io_linux.yo` during the
2026-09-28 Linux async-runtime audit; reproduced by the regression test below.

## Symptom

A single loop tick that starts more operations than the ring has SQ entries
(1,024) completes every operation past the 1,024th **at once, with
`-EAGAIN`**, although the kernel was never asked. Spawning a task per
connection, or 1,500 tasks that each sleep, is enough.

A second, quieter consequence: `__yo_io_arm_notify` silently skipped re-arming
the cross-thread wake channel's `POLL_ADD` when the SQ was full. The channel
then stayed disarmed, so a foreign wake (a `spawn_blocking` finishing, a
`Waker` fired from another thread) could no longer end a blocked wait.

## Reproducer

`tests/sys/file.test.yo`, "1500 file reads started in one tick all complete":
1,500 spawned tasks each start one `read` of a fixture file. The spawned tasks
all run in one drain of the ready queue, so all 1,500 starts land in the
same tick.

- Before: `1024 of 1500 reads completed` on the ring (the rest `-EAGAIN`).
- After: `1500 of 1500`.

`tests/sys/timer.test.yo`'s "1500 sleeps started in one tick" failed the same
way while a sleep was an `IORING_OP_TIMEOUT`; sleeps are now nodes in the
userspace timer heap and take no SQ slot, so that test now guards the heap at
scale.

## Root cause

Submission is deferred: every `__yo_async_*_start` reserves an SQE with
`__yo_uring_get_sqe` and the batch is handed to the kernel at the loop's next
poll/wait. A full SQ is not an error, only a batch that must be flushed
first. But the start functions (and `__yo_io_ring_submit_cancel`,
`__yo_io_arm_notify`) treated `NULL` from `__yo_uring_get_sqe` as final.

## Fix

`__yo_io_get_sqe()` reserves the slot, and on a full SQ submits the queued
SQEs (`__yo_io_flush_sq`) and retries. Only a kernel that refuses the submit
leaves the SQ full. Every reservation site goes through it.

