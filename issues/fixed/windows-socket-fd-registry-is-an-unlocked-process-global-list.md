# Windows: the socket-fd registry is an unlocked process-global list touched by every event loop

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-21;
raised by the runtime sub-audit, verified by reading).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 6). Was: OPEN. **Data race, Windows only.**
**Where:** `src/codegen/async/runtime_io_windows.yo` ~915-956 (`__yo_win_sock_fds`,
`__yo_win_fd_mark_socket` / `_is_socket` / `_unmark_socket`).

## Mechanism

The registry that decides whether a close goes through `closesocket` or the CRT `_close`
(`issues/fixed/windows-file-close-leaks-fd-until-wsa-is-started.md`) is a singly linked list
pushed, walked and unlinked with no lock. Its comment assumes "sockets are created and closed on
the event-loop thread" — but every `Thread` and every pool worker has ITS OWN event loop, so two
threads doing socket I/O push/pop the same list head concurrently: a lost push mis-closes a
socket as a CRT fd, a concurrent unlink walks a freed node.

## Fix direction

Make the registry per-loop (a field of `__yo_loop_t`, `_Thread_local` like the rest of the loop
state — sockets are created and closed by the loop that owns them) or guard it with a
`CRITICAL_SECTION`/`SRWLOCK`. Per-loop is the right shape: it matches the Linux/macOS runtimes,
which keep no process-global fd state. Test: `tests/thread.test.yo` "Thread with async task" run
with a socket per thread on the Windows legs.

## Fix (2026-09-26)

Every access to the registry (`__yo_win_fd_mark_socket`, `__yo_win_fd_is_socket`,
`__yo_win_fd_unmark_socket`, `src/codegen/async/runtime_io_windows.yo`) holds a process-wide
`SRWLOCK` (exclusive for push/unlink, shared for the walk; `SRWLOCK_INIT` is static, so there is
no init race; the unlinked node is freed after the unlock). Process-wide rather than the per-loop
registry the fix direction preferred: a socket handle is a plain value that can move to another
thread, and must still close as a socket there. Gate: the Windows legs and the local `zig cc`
compile.
