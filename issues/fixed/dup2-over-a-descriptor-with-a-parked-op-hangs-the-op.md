# Linux: `dup2` over a descriptor with a parked operation hangs that operation

**Status: FIXED (2026-09-28).** Found by reading `runtime_io_linux.yo` during
the 2026-09-28 Linux async-runtime audit.

## Symptom

`dup2(other, fd)` (`std/sys/pipe.dup2`, `__yo_sync_dup2`) while a `recv` is
parked on `fd`: awaiting that recv hangs forever, on both Linux backends.

## Root cause

`dup2` silently CLOSES `newfd` when it is open. Every other runtime close
path (`__yo_file_close`, the async close) first calls the backend's close
hook, which ends the operations pending on the descriptor with `-EBADF`
(`issues/fixed/io-uring-close-leaves-pending-ops-on-the-fd-running.md`).
`__yo_sync_dup2` did not:

- **io_uring:** the parked RECV holds its own reference to the old socket,
  so it keeps waiting on a file no descriptor names any more.
- **epoll:** the kernel drops the interest with the old file; the parked
  waiter is never delivered, and the slot still describes the old file for
  the reused number.

## Fix

`__yo_sync_dup2` calls `__yo_io_close_hook(newfd)` before `dup2` (when
`oldfd != newfd`). The hook's declaration moved to the top of the Linux sys
runtime so the sync helpers can reach it.

## Test

`tests/sys/socketpair.test.yo`, "dup2 over a descriptor with a parked recv
fails the recv with EBADF" (and its epoll-fallback twin): before the fix the
test hung (killed by `timeout` after 200 s); after, the recv completes with
`-EBADF`, and the duplicate works through the same fd number.
