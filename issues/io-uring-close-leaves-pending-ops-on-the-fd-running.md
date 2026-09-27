# io_uring: closing a descriptor leaves its pending operations running, and an aborted recv cannot be cancelled

**Status: OPEN — fix written, awaiting Linux verification.** Filed 2026-09-27 from
the DROP_LIBURING audit follow-up. The mechanism was established from the code
and the kernel's io_uring semantics (**reasoned**, not yet reproduced on Linux).
The regression tests pass on macOS against kqueue, which already honours both
contracts (**measured**).

## Two defects, one root

The ring backend was the only one whose in-flight operations were invisible
to the rest of the runtime.

1. **Close did not end pending operations.**
   - kqueue (`__yo_kq_drop_fd`) and epoll (`__yo_epoll_drop_fd`) fail a closed fd's
     parked waiters with `-EBADF`, from both the async close and the synchronous
     `__yo_file_close` that std's Dispose paths use.
   - The ring did nothing, and its comment claimed that "closing an fd with
     pending ring ops makes the kernel cancel them". That is false: an io_uring
     request holds its own reference to the file, so closing the descriptor does
     not end it.
   - Consequence: a `recv` pending on a socket that another task closes waits
     for data forever, together with the task awaiting it. A reused descriptor
     number is unaffected in the kernel, but the waiter is stranded.
2. **Aborting a task could not cancel its read/write/recv/send/connect.**
   - Those ring futures had no `cancel_fn`. `__yo_async_io_cancel` therefore
     returned false and the kernel kept the request.
   - An aborted task's recv stayed armed on the socket and **swallowed the next
     data sent to it**, into a buffer nobody reads. A later recv on the same
     socket then hung.
   - Accept and the datagram ops already had cancels, and every parked epoll
     op had one.

## Fix

- `__yo_io_future_t` gains `backend_link` (`src/codegen/types/generation.yo`),
  zeroed by every constructor.
- The ring tracks fd-bound operations in an fd-indexed table of doubly linked
  lists: read, write, recv, send, connect, accept, sendmsg and recvmsg
  (`__yo_ring_track_fd` / `__yo_ring_untrack_fd`, `src/codegen/async/runtime_io_linux.yo`).
  Track and untrack are O(1).
- `__yo_ring_drop_fd` queues an `IORING_OP_ASYNC_CANCEL` by user data (kernel
  5.5, under the ring's floor) for each live operation on the fd. It is
  installed as the thread's close hook, and the async close path calls it too.
  The resulting `-ECANCELED` is reported as `-EBADF`, matching the other backends.
- Read, write, recv, send and connect get `__yo_ring_fd_future_cancel`, the same
  contract as `__yo_accept_future_cancel`.
- `__yo_io_close_hook` is now `_Thread_local`. It was a process global written by
  whichever thread picked a backend, which is a data race once two loop threads
  choose different backends.

## Regression tests

In `tests/sys/socketpair.test.yo`:
- "closing an fd fails the recv still pending on it", with an epoll twin;
- "an aborted task's pending recv does not swallow later data", with an epoll twin.

Before the fix both hang on the ring backend, and the runner's deadline fails
them. The Linux CI legs run them against the tree's runtime.
