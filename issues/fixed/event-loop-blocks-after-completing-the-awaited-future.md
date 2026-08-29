# Event loop: a blocking waiter's step blocks on unrelated I/O after the drain completed its future

**Status: FIXED** (2026-08-29, `src/codegen/async/runtime_core.yo`
`__yo_async_poll_step` + `__yo_async_run_until_complete`).
Regression test: `tests/async_await.test.yo`
"a top-level await returns as soon as its future completes, despite unrelated pending I/O".
Surfaced by audit item C53 (#350): the Linux hollow sweep of
`tests/http/http.test.yo` hung (rc=124) in "fetch decodes a chunked body",
reproduced in a fresh process by `issues/repros/linux-chunked-cond-dispatch.yo`.

## Symptom

`--debug-async-await` on Linux: the client reads the whole chunked response
(`read n=166`, `dechunk Done`), `stream.close` completes, `_fetch_once` →
`_fetch_follow` → `fetch_with` complete in turn ("Future … completed: Setting
state to COMPLETED") — and then nothing. `main`'s top-level
`io.await(fetch_with(...))` never returns; the only pending I/O is the
scripted server's next `accept`, which nobody will connect to.

## Root cause

Every blocking waiter is a loop over one runtime step:

```c
while (state != -1 && state != -2) { __yo_async_poll_step(); state = fut->state; }
```

and the step was

```c
__yo_async_run_ready_tasks();          // may complete `fut`
__yo_io_poll();
if (!queue.head && __yo_has_pending_io()) __yo_io_wait();   // BLOCKS
```

The predicate is re-checked between steps, never inside one. When the drain
completed the awaited future and left the ready queue empty while ANY other
I/O was pending, the step went on to block for that I/O. On io_uring
(`io_uring_wait_cqe`) that wait is indefinite; kqueue's `__yo_io_wait` has a
100 ms timeout, so on macOS the same bug was a silent 100 ms stall per
occurrence and every test passed.

Why the chunked test and not the others: the chain has to complete in a step
that starts from an I/O completion and needs **two more hops** — on Linux
`stream.close` is an io_uring op (an extra completion), so `_fetch_once`
finished in the drain of the following step rather than inline; the
Content-Length tests, and macOS (synchronous close), completed inside the
step that processed the read.

`__yo_async_run_until_complete` (async `main`) had the same shape — the drain
could complete the main future and then wait on a parked accept or timer,
which is the "Linux runtime keeps the process alive after `main` returns"
behaviour recorded in `tests/http` notes.

## Fix

`__yo_async_run_ready_tasks` returns how many tasks it resumed; a step blocks
in `__yo_io_wait` only when it resumed **none** (the rule
`__yo_async_wait_all` already applied via `tasks_processed`). Waiters whose
predicate did not change pay one extra non-blocking iteration; a step that
made progress returns so the caller can re-check. `__yo_async_run_until_complete`
additionally re-reads the main future's state before deciding to wait.

## Not the same bug

The crash hiding behind this hang (heap-use-after-free after the timed-out
fetch) is `issues/fixed/async-scope-end-drop-then-escape-double-drop.md`.
