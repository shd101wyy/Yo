# macOS: an aborted task's parked recv keeps its place and takes the next bytes

**Status: FIXED (2026-09-28).** Found by reading `runtime_io_macos.yo` during
the macOS async-runtime audit, then **reproduced** on macOS 26.6 (M4) with the
seed v0.2.45 and with develop at af62bdb28.

## Symptom

A task suspended in a `recv` on a socket is aborted (`JoinHandle.abort()`, or
`std/async`'s `timeout` when the deadline wins). Another `recv` is then started
on the same socket and parks, and the peer sends one byte. The live recv never
completes. The byte went into the aborted task's buffer.

`docs/en-US/ASYNC_AWAIT.md` ("Operation lifetimes are the same on every
backend") promised the opposite: "Aborting a task cancels the operation it is
suspended in, so an aborted `recv` never consumes data a later `recv` should
see."

## Root cause

The kqueue backend had no cancel path for descriptor operations. Only timers
set `future->cancel_fn`. `__yo_async_io_cancel` therefore reported "cannot
cancel", and the aborted task's recv stayed at the head of its descriptor's
waiter FIFO. When the socket became readable, the FIFO was served in order, so
the dead waiter read the byte. The live waiter queued behind it would-blocked
and waited for more data that never came.

The existing test ("an aborted task's pending recv does not swallow later
data") passed on macOS only by accident. It starts the live recv after the
peer's byte has arrived, so the live recv completes inline and never meets the
parked one. That inline attempt was itself a bug
(`issues/fixed/macos-an-inline-recv-overtakes-a-parked-recv.md`).

## Fix

Each parked operation sets `cancel_fn = __yo_kq_cancel` and
`backend_link = pending`, and holds a reference to its future while parked
(Linux's epoll model). The waiter list is doubly linked, so a cancel unlinks
the waiter in O(1) and completes it with `-ECANCELED`, and its buffer is never
touched again. Events find their registration by `(ident, filter)` through a
per-fd slot table instead of a udata pointer, so a knote that fires after its
last waiter was cancelled finds an empty slot rather than freed memory.

## Test

`tests/sys/socketpair.test.yo`: "an aborted task's parked recv does not take
the bytes of a recv parked after it" (macOS and Linux, plus an epoll-fallback
twin). Before the fix it hangs (killed by `timeout` after 40 s). After, the
live recv gets the byte.
