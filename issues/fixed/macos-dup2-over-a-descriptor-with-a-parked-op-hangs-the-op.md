# macOS: `dup2` over a descriptor with a parked operation hangs that operation

**Status: FIXED (2026-09-28).** The macOS twin of
`issues/fixed/dup2-over-a-descriptor-with-a-parked-op-hangs-the-op.md` (Linux,
fixed in #982). That fix's own report listed the macOS backend as "probably the
same"; it was, and it was **reproduced** on macOS 26.6 (M4) with the seed
v0.2.45 and with develop at af62bdb28.

## Symptom

`dup2(other, fd)` (`std/sys/pipe.dup2`, `__yo_sync_dup2`) while a `recv` is
parked on `fd`: awaiting that recv hangs forever. The test below was killed by
`timeout` after 40 s.

## Root cause

`dup2` silently closes `newfd` when it is open. Every other runtime close path
(`__yo_file_close`, the async close) first calls the backend's close hook,
`__yo_kq_drop_fd`, which fails the operations parked on the descriptor with
`-EBADF`. The macOS `__yo_sync_dup2` did not. The kernel dropped the knote
along with the old file, so the parked waiter was never delivered, and the
registration stayed attached to the fd number for whatever file it named next.

## Fix

`__yo_sync_dup2` calls `__yo_kq_close_hook(newfd)` before `dup2` (when
`oldfd != newfd`). The hook's declaration moved above the helper, and the hook
became `_Thread_local` (see
`issues/fixed/macos-kqueue-close-hook-is-a-process-global-written-by-every-loop-thread.md`).

## Test

`tests/sys/socketpair.test.yo`: "dup2 over a descriptor with a parked recv
fails the recv with EBADF", which previously ran only on Linux, now runs on
macOS too. Before the fix it hangs. After the fix the recv completes with
`-EBADF` (`parked recv after dup2 = -9`), and the duplicate works through the
same fd number.
