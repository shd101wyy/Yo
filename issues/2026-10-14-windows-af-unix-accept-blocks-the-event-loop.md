# On Windows, an AF_UNIX `accept` blocks the single-threaded event loop

**Severity:** S2. On Windows, a program that spawns a Unix-domain server task and only then connects a client on the same loop deadlocks. No test exercises that shape today.

**Status:** OPEN. Split out of `issues/fixed/d6-schannel-hangs-the-windows-test-legs-for-four-hours.md` by the 2026-10-14 S1 triage.

## Symptom

`__yo_async_accept_start` (`src/codegen/async/runtime_io_windows.yo`) arms an overlapped `AcceptEx` only for AF_INET and AF_INET6 listeners. Any other family takes the fallback marked "AF_UNIX, or the extension is unavailable: the historical blocking accept": a plain `accept(ls, ...)` on the event-loop thread, on a default (blocking) socket. A spawned server task that awaits `UnixListener.accept` before its client has connected stops the whole loop inside `accept()`. The client's `connect` never runs.

The TCP version of this is the 4-hour Windows CI hang fixed by #443. The tests in `tests/net/unix.test.yo` connect before they accept, so they never hit it.

## Fix options

- (a) Make the AF_UNIX listener non-blocking (`FIONBIO`) and re-arm accept on readiness, using `WSAPoll` or `WSAEventSelect` integrated with the IOCP loop.
- (b) Run the blocking `accept` on a helper thread that posts a completion packet with `PostQueuedCompletionStatus`. This is about 60–100 lines of C in the Windows runtime.

## Test

An AF_UNIX version of the "accept pending in a spawned task before the client connects" probe in `tests/net/tcp.test.yo`, added to `tests/net/unix.test.yo`. It must run on the Windows leg.
