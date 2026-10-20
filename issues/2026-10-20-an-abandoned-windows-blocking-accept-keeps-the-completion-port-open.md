# On Windows, an abandoned blocking accept can keep the completion port open after it completes

**Severity:** S3. A leak of one completion-port handle, one OVERLAPPED and possibly one accepted socket per event loop. It happens only when a task whose AF_UNIX accept is pending on a pool worker is aborted, and the worker then returns (for example after `listener.close`) without the loop dequeuing its packet. Not a correctness bug.

**Status:** OPEN. Found 2026-10-20 by the adversarial review of the fix in `issues/fixed/2026-10-14-windows-af-unix-accept-blocks-the-event-loop.md` (#1484).

## Mechanism (traced in `src/codegen/async/runtime_io_windows.yo`)

1. The task is aborted. `__yo_win_blocking_accept_cancel` marks the op abandoned, sets `ov->future = NULL`, and does `__yo_pending_io_count--`.
2. The worker's `accept()` returns and posts the OVERLAPPED to the port.
3. The loop exits without dequeuing that packet. `__yo_io_poll` returns early when `__yo_pending_io_count == 0 && __yo_active_watch_count == 0 && __yo_win_pipe_reads == NULL`, and `__yo_io_wait` has a similar early return. So the packet waits for some unrelated I/O to drain the port.
4. `__yo_io_cleanup` closes the port only when `__yo_win_pipe_writes_inflight == 0 && __yo_win_blocking_accepts_inflight == 0`. `inflight` is decremented only in `__yo_win_blocking_accept_done`, which never ran, so the port stays open. The fixed doc's teardown rule meant this for a worker that is still blocked, but here the worker has already posted.

## Fix direction

Before `__yo_io_cleanup` decides whether to close the port, drain it with a zero-timeout `GetQueuedCompletionStatusEx`. Hand each dequeued blocking-accept packet to `__yo_win_blocking_accept_done`, which closes the socket and frees the OVERLAPPED of an abandoned op. Then close the port when `inflight` reaches zero.

Two constraints apply:
- The drain must run BEFORE cleanup zeroes `__yo_win_blocking_accepts` and `__yo_win_blocking_accepts_inflight`. Otherwise `done()` underflows the `size_t` count.
- Packets of other kinds must not be processed through the ordinary completion path during teardown, because that path wakes continuations.

## Test

None is possible on the macOS box where this was found, because the Windows runtime runs only on the Windows CI legs. A test needs a hook that reports whether cleanup closed the port. It would extend `tests/net/unix.test.yo`'s "aborting a task whose accept is pending releases it" case: close the listener after the abort, then let the loop exit.
