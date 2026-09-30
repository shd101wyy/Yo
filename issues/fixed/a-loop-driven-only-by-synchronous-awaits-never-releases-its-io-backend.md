# A loop driven only by synchronous awaits never releases its I/O backend

**Severity:** S3 — a program whose awaits are all synchronous exits with its I/O backend state still allocated, so `leaks`/LeakSanitizer report it; nothing accumulates per thread

**Status: FIXED (2026-09-29).** Filed 2026-09-28 from the macOS async-runtime audit.
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

## Fix (2026-09-29)

Half of this landed first with #989
(`issues/fixed/thread-local-async-registries-leak-at-thread-exit.md`): the
thread-exit hook (`__yo_async_free_cont_pool`) now also runs the idempotent
`__yo_io_cleanup`. Two gaps remained, both measured with `leaks --atExit` on
macOS 26.6 (`--optimize 0 --allocator system`, so frames are named):

- The hook was armed only when the first continuation node was allocated. A
  plain `main(io)` whose awaits never allocate one (raw I/O, a lone sleep)
  never armed it. `io.await(sleep(1), io)` leaked the timer heap
  (160 B, `__yo_timer_arm`).
- The macOS cleanup kept the slot table and the node pools for a later
  re-init. A socketpair send + recv leaked the slot table (1.75 KB,
  `__yo_kq_slot_grow`), a pooled pending op (160 B) and a registration (48 B).

Now:

- `__yo_async_arm_thread_exit` (`runtime_core.yo`) arms the hook, and every
  backend's `__yo_io_init` calls it, as does the continuation pool: macOS,
  Linux, Windows, wasm.
- The macOS `__yo_io_cleanup` also frees the slot table and both pools, and
  clears the close hook. `__yo_io_init` rebuilds them from empty.

After: the sleep program leaks nothing. The socketpair program's backend blocks
are gone. Its one remaining block is an unrelated leak of a raw extern future
(`issues/fixed/a-raw-extern-io-future-awaited-synchronously-as-a-temporary-is-never-released.md`).
The first measurement was on the emitted C with the change applied by hand;
the same run was repeated with the built compiler in the PR's gate.

Regression pin: `tests/internal/uring_runtime.test.yo` ("every backend arms
the thread-exit hook at init"). CI runs with `detect_leaks=0`, so no language
test can observe an exit-time leak; the pin holds the emitted shape.
