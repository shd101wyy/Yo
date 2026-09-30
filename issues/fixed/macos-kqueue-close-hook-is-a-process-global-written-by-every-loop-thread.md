# macOS: the kqueue close hook is a process-global written by every loop thread

**Status: FIXED (2026-09-28).** Read from the code during the macOS
async-runtime audit. It is the macOS twin of the Linux item in
`issues/fixed/linux-io-runtime-minor-defects-from-the-drop-liburing-audit.md` (item
3, `__yo_io_close_hook`), and of Windows' `__yo_win_close_hook` and
`issues/fixed/async-thread-exit-hook-is-a-process-global-written-by-every-thread.md`.

## Mechanism

`static void (*__yo_kq_close_hook)(int32_t)` was a process-global. Every
thread's `__yo_io_init` wrote it (with the same value), and every thread's
sync close read it. That is a data race in C11 terms, which ThreadSanitizer
reports. It was also imprecise: the function it points at purges the CALLING
thread's registrations, so a thread that never ran a loop still took the
purge path on every close.

## Fix

The hook is `_Thread_local`, set by the thread's own `__yo_io_init`, and NULL
on a thread without a loop. Its declaration moved above `__yo_sync_dup2`,
which now calls it too
(`issues/fixed/macos-dup2-over-a-descriptor-with-a-parked-op-hangs-the-op.md`).

## Verification

The async/net/sys/fs/thread corpus passes on macOS, including
`tests/cross_thread_wake.test.yo` and `tests/thread.test.yo`, whose threads
each run loops. macOS has no ThreadSanitizer CI leg, so the race itself was
not observed. The fix removes the shared write.
