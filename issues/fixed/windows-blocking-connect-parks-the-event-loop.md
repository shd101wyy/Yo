# Windows: `io` connect runs a BLOCKING `connect()` on the event-loop thread

**Status: FIXED (2026-09-12).** `__yo_async_connect_start`
(`src/codegen/async/runtime_io_windows.yo`) called the plain blocking
`connect()` and returned an already-complete future. The socket is
blocking (`WSASocketW(..., WSA_FLAG_OVERLAPPED)` — overlapped, not
non-blocking), so the call parks the WHOLE single-threaded event loop
inside the kernel for the duration of the TCP handshake: milliseconds on
loopback, but the full SYN-retransmit window — measured **21.3 s** —
against a black-holed address, with every concurrent task (timers, other
sockets, the accept path) frozen behind it.

This is the same class as the D6 accept hang
(`issues/fixed/d6-schannel-hangs-the-windows-test-legs-for-four-hours.md`,
fixed by the overlapped AcceptEx port in be3b42aa6): connect was simply
never given the same treatment. On Linux the same operation goes through
`io_uring_prep_connect` and never parks the loop, so this is a Windows
divergence, not a cross-platform stance.

Found 2026-09-12 by the Windows async-I/O runtime audit
(`audit/windows-async-io`). **Severity:** HIGH — any connect to a slow,
filtered or unreachable address freezes all concurrency; `Tcp.net.connect`
to a peered-but-slow endpoint stalls unrelated timers.

## Reproducer

```rust
// tmp/connect_blocks.yo — 192.0.2.1 is TEST-NET-1 (RFC 5737): never
// delivered, so the connect stays pending for the whole retry window.
pragma(Pragma.AllowUnsafe);
{ IpAddr, SocketAddr } :: import("std/net/addr");
{ TcpStream } :: import("std/net/tcp");
{ Exception, IoExn } :: import("std/error");
{ sleep } :: import("std/sys/timer");
{ Instant } :: import("std/time/instant");
{ println } :: import("std/fmt");

main :: (fn(io : Io, exn : Exception) -> unit)({
  addr := SocketAddr.new(IpAddr.V4(u8(192), u8(0), u8(2), u8(1)), u16(81));
  started := Instant.now();
  io.spawn(
    io.async((io : Io) => {
      task_exn := Exception(
        throw : (err -> { unwind(()); })
      );
      stream := io.await(TcpStream.connect(addr, io), IoExn(io : io, exn : task_exn));
      io.await(stream.close(io), IoExn(io : io, exn : task_exn));
      return(());
    }),
    io
  );
  io.spawn(
    io.async((io : Io) => {
      io.await(sleep(u64(300)), io);
      return(());
    }),
    io
  );
  sleep_task.await(io); // sleeps the 300 ms task
  elapsed_ms := started.elapsed().as_millis();
  cond(
    (elapsed_ms >= i64(900)) => {
      println(`BLOCKING CONFIRMED: the 300 ms sleep took ${elapsed_ms} ms`);
    },
    true => {
      println(`OK: the 300 ms sleep took ${elapsed_ms} ms`);
    }
  );
});
export(main);
```

Before the fix: `BLOCKING CONFIRMED: the 300 ms sleep took 21341 ms`.
After: `OK: the 300 ms sleep took 316 ms`. (The `sleep_task.await(io)`
line is spelled as a statement in the real repro; the harness exits
without the still-pending connect — `__yo_async_run_until_complete`
breaks when the main future completes even with I/O outstanding.)

## Fix

`__yo_async_connect_start` now issues the overlapped **ConnectEx**
extension — the connect-side twin of the landed AcceptEx work:

- `LPFN_CONNECTEX` fetched via `WSAIoctl(SIO_GET_EXTENSION_FUNCTION_POINTER)`,
  thread-local cached like the AcceptEx pointers.
- Gated to `AF_INET`/`AF_INET6` **stream** sockets, decided from the
  socket's own family (`getsockname`) and type (`getsockopt(SO_TYPE)`)
  BEFORE consulting the cached pointer — the same thread-local-caching
  trap the accept path documents for AF_UNIX.
- The socket is bound to the family wildcard first (ConnectEx requires a
  bound socket; an already-bound one just gets WSAEINVAL here).
- `is_connect` on the overlapped struct; `__yo_win_process_completion`
  sets `SO_UPDATE_CONNECT_CONTEXT` on success (without it getpeername/
  shutdown on the socket fail), and the synchronous-completion case
  (loopback: ConnectEx returns TRUE, no IOCP packet under
  FILE_SKIP_COMPLETION_PORT_ON_SUCCESS) finishes inline.
- Everything else — AF_UNIX (no ConnectEx exists there), datagram sockets
  (UDP `connect()` is a local, immediate filter install), or the extension
  being unavailable — keeps the plain `connect()`.

Abort semantics are unchanged: an aborted task suspended in a pending
ConnectEx leaves the operation registered until it completes naturally —
the documented fallback for every overlapped op whose future has no
`cancel_fn` (only timers do, `runtime_core.yo`).

Regression test: `tests/net/tcp.test.yo` "connecting to a non-routable
address does not park the event loop" (the repro's timing assert; on a
network that refuses TEST-NET immediately the connect resolves fast and
the assert passes, just less discriminatingly). The loopback connect/echo
battery in the same file covers ConnectEx's synchronous completion and
error mapping.
