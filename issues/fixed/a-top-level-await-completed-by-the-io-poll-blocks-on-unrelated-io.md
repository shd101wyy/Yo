# Event loop: a top-level await completed by the I/O poll blocks on unrelated I/O

**Status: FIXED (2026-09-28).** Found while writing the 2026-09-28 Linux
async-runtime audit's regression tests: a test that parked two recvs on one
socket and awaited them at top level hung on both Linux backends.

## Symptom

A blocking waiter — a top-level `io.await` in `main` or a test body,
`JoinHandle.await`, a std/async combinator — whose awaited I/O future is
completed by the loop's poll never returns while any OTHER operation is
pending, until that other operation completes. With a recv that nobody will
ever feed, forever.

## Reproducer

`tests/sys/socketpair.test.yo`, "a top-level await completed by the I/O
poll returns despite unrelated pending I/O" (and its epoll twin): a recv
parked on one socketpair (never fed), a recv parked on another, a send that
feeds the second, and a top-level await of the second. Before: the await
hangs (killed by `timeout` after 120 s, both backends). After: it returns 1.

## Root cause

Every blocking waiter loops over `__yo_async_poll_step` and re-checks its
predicate BETWEEN steps. The step ran the ready tasks, polled the backend,
and then blocked in `__yo_io_wait` if no task had run
(`issues/fixed/event-loop-blocks-after-completing-the-awaited-future.md`
added that "if no task ran" guard). But a top-level await of an I/O future
registers no continuation, so the poll that completes it runs no task: the
guard saw `ran == 0` and the step blocked on the unrelated operation.
Hidden on macOS by kqueue's 100 ms wait timeout (a 100 ms stall per
occurrence), indefinite on io_uring and epoll.

## Fix

`__yo_async_poll_step` blocks only when the step resumed no task AND its
poll completed nothing (`__yo_io_poll`'s return, a completion count on every
backend). `runtime_core.yo` is shared, so the fix applies to every platform.
