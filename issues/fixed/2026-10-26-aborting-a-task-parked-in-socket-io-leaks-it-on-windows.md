# Aborting a task parked in socket I/O leaks it (and its socket) on Windows

**Severity:** S2 (platform runtime gap: task, captures and socket leak until an
arbitrary completion arrives; blocks the #1617 scoped-exchange contract on
Windows)

## What happened

Both Windows legs of develop battery 40261184520 (af67fdf59, 2026-10-26)
failed the same NEW #1617 test, `tests/http/http.test.yo`:

```
✗ an aborted HttpClient fetch takes its exchange down with it
  Test failed with exit code 22
  the exchange closed its connection when the fetch was aborted (server saw Some(2))
```

The test aborts an `HttpClient.fetch_with` mid-exchange with the caller's own
`timeout(…, 100ms)` and asserts the server then sees the connection CLOSE
(`Some(0)`). The Linux and macOS legs pass.

## Root cause (reading-level; no Windows box was available)

`std/async`'s `timeout` and `_deadline_join` abort their operand task through
`__yo_future_abort` → the state machine's abort hook →
`__yo_async_io_cancel(await_slot)`. That cancel SUCCEEDS only when the pending
operation's future carries a `cancel_fn`:

- epoll: every socket op gets `__yo_epoll_cancel`
  (`src/codegen/async/runtime_io_linux.yo`, 10+ sites);
- kqueue: `__yo_kq_cancel` (`runtime_io_macos.yo`);
- **Windows: NONE.** `runtime_io_windows.yo` set `cancel_fn` only for the
  blocking-accept and the timer. `__yo_async_send_start`,
  `__yo_async_recv_start`, `__yo_async_sendto_start`,
  `__yo_async_recvfrom_start`, the AcceptEx arm and the ConnectEx arm all
  returned futures with no cancel path.

So on Windows, aborting a task parked in socket I/O marks the task `-2` but
cannot free it: the abort hook's `__yo_async_io_cancel` returns false, the
state machine (with everything it captured — a `TcpStream`, its socket, the
caller's buffer) stays alive until the operation completes BY ITSELF. For the
test's exchange — parked in a read against a server that never answers —
that is forever: the connection stays open and the #1617 contract ("the
scoped child is aborted with the fetch, so the server sees the connection
close", the fix for the detached-exchange use-after-free) is unsatisfable.

The CI oracle read `Some(2)` — the server's probe read returned data after
the request — which I could not derive byte-for-byte from the code by
reading. What IS established by reading: without a cancel path the abort
path never runs on Windows at all, so the test cannot produce its expected
`Some(0)` there regardless. The fix below makes the abort path actually
execute; the Windows CI legs are the confirmation (see "Verification").

## Fix

Give every pending Windows socket operation a cancel hook, the pattern the
blocking-accept cancel already established (`__yo_win_blocking_accept_cancel`):
IOCP cannot unpost an operation, so CANCEL = ABANDON —

- `__yo_win_sock_cancel(future)`: find the op's overlapped on a new per-loop
  list of pending socket ops (`__yo_win_sock_ops`, linked through a new
  `next_sock` field; submits and cancels both run on the loop thread), mark
  it `sock_abandoned`, `CancelIoEx` (recalls the kernel's hold on the
  caller's buffer; the packet STILL arrives, with
  ERROR_OPERATION_ABORTED), release the future's reference, and take the
  pending-I/O count.
- `__yo_win_process_completion`: a packet for an abandoned op delivers
  nothing — it only recycles the overlapped (and closes an abandoned
  AcceptEx's pre-created socket); a NORMAL completion unlinks the overlapped
  before freeing it.
- The teardown clears the list with the port (its packets die with it).

With the hook in place, `__yo_async_io_cancel` succeeds → the abort hook
frees the exchange task → its `conn`'s `Drop` runs `close_sync` → the server
sees the FIN. Linux and macOS behavior is untouched (their runtimes are
separate files).

## Verification

- Reading-level for Windows (no Windows box): the cancel follows the
  proven blocking-accept pattern; refcounts and the pending count balance
  exactly as that path's do.
- Locally (Linux, tree-built `yo`): `yo check ./src` and `yo check ./std`
  green; `tests/http/http.test.yo` (all 52 tests incl. the aborted-fetch
  one) green on epoll, uring and the default backend; `tests/net/tcp.test.yo`
  (25 tests, epoll and default), `tests/net/udp.test.yo`, `tests/net/dns.test.yo`,
  `tests/net/unix.test.yo` (8 tests), `tests/fs/watch.test.yo` (default and
  epoll), `tests/async/mutex.test.yo`, `tests/thread.test.yo` and
  `tests/cross_thread_wake.test.yo` green under `YO_TEST_LEAK_VERDICT=0` — the
  Linux emission does not include this runtime, so those runs guard against
  accidental cross-platform damage only. Without the knob tcp and unix still
  fail their LeakSanitizer verdict, from the two known open abort-leak issues
  (`issues/2026-10-22-an-aborted-accept-leaks-its-peer-address-buffers.md`,
  `issues/2026-10-24-an-aborted-task-never-drops-its-by-value-captures.md`);
  CI sets the knob for these, and neither leak involves this change.
- `yo compile --target x86_64-pc-windows-msvc --emit-c` (a sleep-only `main`)
  emits the whole socket runtime into the C: `__yo_win_sock_cancel` 8x,
  the `sock_abandoned` guard 6x, and exactly 6 `cancel_fn = __yo_win_sock_cancel`
  hookup sites beside 6 `next_sock` list sites — one per submit path
  (accept, connect, send, recv, sendto, recvfrom).
- The Windows legs of the develop battery are the real confirmation: both
  `test (windows-latest)` and `test (windows-11-arm)` shard 1/4 should turn
  green on `tests/http/http.test.yo`.
