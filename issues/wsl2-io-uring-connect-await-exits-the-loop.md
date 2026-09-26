# On WSL2, an io_uring TCP connect await ends the loop silently (rc=0, program truncated)

**Status: OPEN** — filed 2026-09-26 from the DROP_LIBURING Phase 6 gates.
Pre-existing: reproduces identically with the pre-DROP_LIBURING baseline
compiler. Environmental on WSL2 (CI's ubuntu runners pass `tests/net/tcp`
on develop); the epoll fallback completes the same program on the same box.

## Symptom

A program whose async main awaits `TcpStream.connect` on WSL2 (kernel
6.6.87.2-microsoft-standard-WSL2) prints output up to the connect, then the
process EXITS rc=0 — the connect never completes and the event loop decides
there is no work left. Under `YO_IO_BACKEND=epoll` the same program completes.

## Reproducer (WSL2 box)

```rust
{ println } :: import("std/fmt");
{ String } :: import("std/string");
{ TcpListener, TcpStream } :: import("std/net/tcp");
{ SocketAddr } :: import("std/net/addr");
{ sleep } :: import("std/sys/timer");
{ Exception, IoExn } :: import("std/error");
main :: (fn(io : Io) -> unit)({
  println(String.from("before"));
  listener := io.await(TcpListener.bind(SocketAddr.loopback(u16(0)), io), IoExn(io : io, exn : Exception(throw : ((_e) -> unwind(())))));
  addr := listener.local_addr();
  client := io.await(TcpStream.connect(addr, io), IoExn(io : io, exn : Exception(throw : ((_e) -> unwind(())))));
  println(String.from("connected"));
  io.await(sleep(u64(5)), IoExn(io : io, exn : Exception(throw : ((_e) -> unwind(())))));
});
export(main);
```

Expected: `before` then `connected`. On WSL2 with the io_uring backend: only
`before`, rc=0. A/B: the pre-DROP_LIBURING baseline compiler behaves the
same, and `tests/net/tcp.test.yo` fails 23/23 on WSL2 with BOTH compilers
(the local leak-detector failures are a separate, also-local class);
`YO_IO_BACKEND=epoll` completes the program.

## Root cause (hypothesis, unverified)

The connect's ring op appears to the loop as if it were not pending when it
blocks in the kernel on WSL2 — the loop exits with the future unresolved
instead of waiting for its CQE. Whether the CQE is delivered but dropped, or
the submission fails in a way the accounting misses, is undetermined; it
needs a WSL2 box and a trace of the ring's CQ around the connect. CI runners
(ubuntu, stock kernels) do not reproduce, so this is a WSL2-interaction bug,
not a general one.

## Fix direction

Trace `io_uring_enter`/CQE delivery for the connect SQE on WSL2 (`strace -e
io_uring_setup,io_uring_enter`). If the CQE never arrives, compare WSL2's
io_uring TCP connect against mainline; if it arrives late or dropped, audit
the loop's pending-accounting around teardown-on-idle. The epoll fallback
(existing behavior, plans/DROP_LIBURING.md Phase 5) is the correct workaround
ON THIS MACHINE CLASS — not a fix.
