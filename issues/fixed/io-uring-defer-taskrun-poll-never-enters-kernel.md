# Linux: `__yo_io_poll` never enters the kernel, so under `IORING_SETUP_DEFER_TASKRUN` a busy event loop never sees I/O complete

**Found**: 2026-08-28 — the C33 `fetch throws Timeout` test (and #332's live
1 ms-timeout test under the same client) hung ONLY on the Linux CI legs;
macOS passed 10/10. **Status**: FIXED — `src/codegen/async/runtime_io_linux.yo`,
`__yo_io_poll`.

## Symptom

A poll-until-finished race inside a task:

```rust
h := e.io.spawn(_fetch_follow(url, opts, e.io), e);
dh := e.io.spawn(sleep(limit, e.io), e.io);
while(runtime(!(h.is_finished()) && !(dh.is_finished())), {
  e.io.await(yield(e.io), e.io);
});
```

spins forever on Linux: neither the 100 ms timerfd read behind `dh` nor the
peer socket behind `h` ever completes. The same program finishes in ~100 ms on
macOS.

## Mechanism

`__yo_io_init` creates the ring with `IORING_SETUP_DEFER_TASKRUN` (plus
`SINGLE_ISSUER`, `COOP_TASKRUN`): the kernel runs completion task-work — i.e.
posts CQEs — only when the owning thread enters the ring with
`IORING_ENTER_GETEVENTS`. `__yo_io_poll` was

```c
__yo_io_flush_sq();                       // io_uring_submit ONLY if SQEs are queued
while (io_uring_peek_batch_cqe(...)) …    // pure userspace CQ-ring read
```

While the ready queue is never empty (the `yield` loop re-enqueues its task
every step — C40 made that a bounded drain, not a hang, but the queue still
never empties) `__yo_async_poll_step` never reaches `__yo_io_wait`, no SQE is
pending so `flush` does not syscall either, and the peek reads a CQ ring the
kernel has not been asked to fill. On kqueue (macOS) polling is itself a
`kevent` syscall, which is why the platforms diverged.

## Fix

`__yo_io_poll` performs one zero-timeout `io_uring_wait_cqe_timeout` before
peeking — a non-blocking `io_uring_enter(GETEVENTS)` that materialises pending
completions and consumes nothing. Every other completion path (`__yo_io_wait`,
the async-`main` loop) already entered the kernel and is unchanged.

## Gate

`tests/http/http.test.yo` "fetch throws Timeout when the server never answers"
and `tests/http/http_limits.test.yo` "with_timeout drives a too-short deadline
to HttpError.Timeout" on the Linux legs (RED rc=124 in the hollow sweep of
PR #333 before; the same sweep after).
