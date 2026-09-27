# io_uring: every `sleep` costs three syscalls and a worker-thread round trip

**Status: FIXED (2026-09-27, #964).** Filed the same day from the DROP_LIBURING
audit.

**Measured after the fix,** on stock Linux (`ubuntu-latest`, the io-budgets job):
- the ring's timer throughput is at parity with the epoll fallback's timerfd
  (epoll/ring 0.967, against 20.3× on the WSL2 box with the old code);
- budget B is 150 syscalls for 50 ticks on the ring, against 200 on epoll.

No stock-Linux run of the old timerfd-READ code exists, so the before/after
comparison on one machine was not made.

**Provenance:**
- The **code shape is read from the tree.**
- The **punt is reasoned**: io_uring cannot issue a nonblocking read on a
  file without `FMODE_NOWAIT`, and it sends such a read to an io-wq worker,
  which blocks in it and completes from there.
- The **symptom is circumstantial**: the Phase 6 bench measured epoll's
  `sleep(0)` churn at 20.3× the ring's on WSL2.
- A before/after table on a stock Linux runner is the acceptance check.

## Shape

`__yo_async_sleep_start` (`src/codegen/async/runtime_io_common.yo`), ring path,
before the fix:

1. `timerfd_create`
2. `timerfd_settime`
3. `IORING_OP_READ` of 8 bytes on the timerfd, which is the punted op
4. on dispose, `close` of the timerfd

`plans/reference/DROP_LIBURING.md` §2.1 described this as "timerfd + `POLL_ADD`". The code
actually did a `READ`.

## Fix

A ring sleep is one relative `IORING_OP_TIMEOUT` SQE (kernel 5.4, under the ring's
5.6 floor):
- no descriptor, and no syscall of its own;
- it rides the batched submit;
- the kernel's hrtimer completes it in the owning task.
- The deadline lives in the timer future (`__yo_timer_future_t.ts`), because the
  kernel copies it when the SQE is submitted, which can be a deferred batch later.
- Expiry reports `-ETIME`, which the CQE path maps to the timer contract's 8
  (`std/sys/timer.yo`: "Resolves to 8 on success").
- Cancel is unchanged: `IORING_OP_ASYNC_CANCEL` by user data also cancels
  timeouts.
- The epoll fallback keeps the timerfd, since it has no timeout op.

`tests/internal/uring_runtime.test.yo` pins `__yo_uring_prep_timeout` and asserts
that the timerfd read is gone.
