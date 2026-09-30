# A loop driven only by synchronous awaits never releases its I/O backend

**Severity:** S3 — a program whose awaits are all synchronous exits with its I/O backend state still allocated, so `leaks`/LeakSanitizer report it; nothing accumulates per thread

**Status: OPEN.** Filed 2026-09-28 from the macOS async-runtime audit.
**Measured** on macOS 26.6. Linux has the same shape: the async state-machine
audit re-verification in `issues/fixed/pending-io-future-local-drop-uaf.md` saw
"the tree build leaks the 128 B timer-heap array at exit".

## Symptom

A program whose `main(io)` is a plain function (not `io.async`) awaits through
`__yo_async_poll_step` loops, as does a test body. On exit, `leaks --atExit`
reports the thread's I/O backend state:

```
Process 72162: 1 leak for 640 total leaked bytes.
ROOT LEAK: <realloc in yo_id_…>   (the timer heap's array, from __yo_timer_arm)
```

The same path keeps the loop's slot table, the pending/registration free
lists and the kqueue descriptors (Linux: the ring, the epoll fd, the timer
array). Memory is reclaimed when the process exits, but LeakSanitizer and
`leaks` report it for every such program.

Threads are **not** affected. 300 `Thread.spawn`s that each await once leave
exactly one kqueue open (the main thread's), measured with `lsof`, so nothing
accumulates per thread.

## Root cause

`__yo_io_cleanup` runs only at the end of `__yo_async_run_until_complete`. The
thread-exit hook (`__yo_async_thread_exit_hook`, #970) frees only the
continuation pool, and it is installed only when a continuation node is first
allocated.

## Fix direction

A core `__yo_async_thread_exit` that frees the pool and then calls the
backend's (idempotent) `__yo_io_cleanup`, installed by every backend's
`__yo_io_init` as well as by the pool. It changes the exit path on all four
backends, so it needs each platform's CI. `__yo_io_cleanup` should also free
the backend's tables (macOS: `__yo_kq_slots` and the free lists), which it
leaves allocated today because a later re-init reuses them.
