# On Windows, an AF_UNIX `accept` blocks the single-threaded event loop

**Severity:** S2. On Windows, a program that spawns a Unix-domain server task and only then connects a client on the same loop deadlocks. No test exercises that shape today.

**Status:** FIXED 2026-10-20 (option (b) below). Split out of `issues/fixed/d6-schannel-hangs-the-windows-test-legs-for-four-hours.md` by the 2026-10-14 S1 triage.

## Symptom

`__yo_async_accept_start` (`src/codegen/async/runtime_io_windows.yo`) arms an overlapped `AcceptEx` only for AF_INET and AF_INET6 listeners. Any other family takes the fallback marked "AF_UNIX, or the extension is unavailable: the historical blocking accept": a plain `accept(ls, ...)` on the event-loop thread, on a default (blocking) socket. A spawned server task that awaits `UnixListener.accept` before its client has connected stops the whole loop inside `accept()`. The client's `connect` never runs.

The TCP version of this is the 4-hour Windows CI hang fixed by #443. The tests in `tests/net/unix.test.yo` connect before they accept, so they never hit it.

## Fix options

- (a) Make the AF_UNIX listener non-blocking (`FIONBIO`) and re-arm accept on readiness, using `WSAPoll` or `WSAEventSelect` integrated with the IOCP loop.
- (b) Run the blocking `accept` on a helper thread that posts a completion packet with `PostQueuedCompletionStatus`. This is about 60–100 lines of C in the Windows runtime.

## Fix (2026-10-20)

Option (b), modeled on the pipe-write worker that the same runtime already
uses for anonymous pipes. A listener that AcceptEx cannot serve (AF_UNIX, or
the extension is unavailable) no longer calls `accept()` on the loop thread.
`__yo_win_blocking_accept_start` submits the plain blocking `accept()` to a
thread-pool worker (`TrySubmitThreadpoolCallback`). The worker accepts into
the OVERLAPPED's own address buffer and posts the OVERLAPPED to the loop's
completion port. The loop dequeues it like any other packet, and
`__yo_win_blocking_accept_done` then does on the loop thread what the
synchronous path did: it copies the peer address out, joins the socket to the
port, marks it a socket, and wakes the task.

- **The worker touches no loop state.** It writes only the accepted socket,
  the address length and the errno, all of them OVERLAPPED fields, and posts
  to the port it captured at submit. The port is the barrier between the two
  threads.
- **Cancellation.** A worker blocked in `accept()` cannot be recalled, so the
  future's `cancel_fn` ABANDONS the op instead. It releases the future, and
  the op stops counting as pending I/O, so an aborted server task does not
  keep the loop alive. If a completion arrives later, it closes the socket it
  accepted for nobody.
- **Teardown.** Like a stuck pipe write, a blocking accept still on a worker
  keeps the completion port open past `__yo_io_cleanup`, because its worker
  will post to it. Cleanup aborts every task parked on one through the
  ordinary abort path (`__yo_io_teardown_abort_waiters`), the way it handles
  timers.
  A worker that has already posted for an ABANDONED op can still leave the
  port open, because nothing dequeues its packet once the op stops counting
  as pending: `issues/2026-10-20-an-abandoned-windows-blocking-accept-keeps-the-completion-port-open.md`
  (S3, open).

Verified on Windows by the PR's CI legs only. This macOS box cannot run the
Windows runtime: the emitted C was cross-compiled with
`zig cc -target x86_64-windows-gnu` to check that it builds.

## Test

`tests/net/unix.test.yo` has two new cases, and both run on every platform's leg, Windows included:
- "accept pending in a spawned task before the client connects" is the AF_UNIX twin of the `tests/net/tcp.test.yo` probe. Before the fix it deadlocked on Windows.
- "aborting a task whose accept is pending releases it" exercises the abandon path.
