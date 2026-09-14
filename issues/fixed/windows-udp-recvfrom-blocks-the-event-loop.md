# Windows: UDP `sendto`/`recvfrom` run blocking calls on the event-loop thread

**Status: FIXED (2026-09-12).** `__yo_async_sendto_start` and
`__yo_async_recvfrom_start`
(`src/codegen/async/runtime_io_windows.yo`) called the plain blocking
`sendto`/`recvfrom` and returned already-complete futures. On a quiet
socket `recvfrom` blocks until a datagram arrives — a UDP server task
awaiting `UdpSocket.recv_from` with no traffic parked the ENTIRE event
loop inside the kernel, freezing every timer, socket and fs watch. Same
bug class as the D6 accept hang and the blocking connect (both fixed);
`send`/`recv` on the same runtime were already overlapped
(`WSASend`/`WSARecv`), so the datagram pair was the remaining gap.

Found 2026-09-12 by the Windows async-I/O runtime audit
(`audit/windows-async-io`). **Severity:** HIGH for any concurrent UDP
workload — one quiet `recv_from` freezes the process; a UDP server is
unusable alongside anything else on the loop.

Note the Linux backend has the same shape ("io_uring doesn't have direct
sendto, use synchronous", `runtime_io_linux.yo`) — but there the sockets
are still blocking too, so the freeze is cross-platform for the DATAGRAM
ops today. Fixing Windows does not regress parity (it improves it); the
Linux side would want `IORING_OP_SENDTO/RECVFROM` or non-blocking +
multishot recv, tracked in the audit summary issue
(`issues/windows-async-io-runtime-audit.md`).

## Reproducer

```rust
// tmp/udp_overlapped.yo — a quiet recv_from must park the TASK, not the
// loop: the 200 ms sleep is issued while the recv is pending and must
// still complete on time.
pragma(Pragma.AllowUnsafe);
{ assert } :: import("std/assert");
{ SocketAddr } :: import("std/net/addr");
{ UdpSocket } :: import("std/net/udp");
{ sleep } :: import("std/sys/timer");
{ Instant } :: import("std/time/instant");
{ ArrayList } :: import("std/collections/array_list");
{ GlobalAllocator } :: import("std/allocator");
{ malloc, free } :: GlobalAllocator;
{ println } :: import("std/fmt");
{ Exception, IoExn } :: import("std/error");

main :: (fn(io : Io, exn : Exception) -> unit)({
  server := io.await(UdpSocket.bind(SocketAddr.loopback(u16(0)), io), IoExn(io : io, exn : exn));
  client := io.await(UdpSocket.bind(SocketAddr.loopback(u16(0)), io), IoExn(io : io, exn : exn));

  recv_task := io.spawn(
    io.async((io : Io) => {
      task_exn := Exception(throw : (err -> { unwind(()); }));
      recv_buf := (*u8)(malloc(usize(64)).unwrap());
      got := io.await(server.recv_from(recv_buf, usize(64), io), IoExn(io : io, exn : task_exn));
      (n, from) := got;
      assert((n == usize(5)), "expected 5 bytes");
      assert(from.ip.is_loopback(), "sender address decoded");
      free(.Some((*void)(recv_buf)));
      return(());
    }),
    io
  );

  started := Instant.now();
  io.await(sleep(u64(200)), io);
  (sleep_ms : i64) = started.elapsed().as_millis();

  data := ArrayList(u8).new();  // "ping!"
  data.push(u8(112)); data.push(u8(105)); data.push(u8(110));
  data.push(u8(103)); data.push(u8(33));
  sent := io.await(client.send_to(data, server.local_addr(), io), IoExn(io : io, exn : exn));
  assert((sent == usize(5)), "send_to sent 5 bytes");

  recv_task.await(io);
  assert((sleep_ms < i64(500)), "sleep was delayed by a pending recv_from");
  io.await(client.close(io), IoExn(io : io, exn : exn));
  io.await(server.close(io), IoExn(io : io, exn : exn));
});
export(main);
```

Before the fix the program DEADLOCKS (the loop is inside `recvfrom`, the
200 ms sleep never runs, the datagram is never sent). After:
`concurrent sleep took 200 ms`, datagram + decoded sender address
delivered.

## Fix

Both ops mirror the landed `WSASend`/`WSARecv` shape exactly — associate
the socket with the port, an overlapped struct, sync-completion /
`WSA_IO_PENDING` / error arms. One datagram-specific wrinkle:
`WSARecvFrom` writes the source-address LENGTH at completion time, so it
cannot point at a caller stack local that dies with the start call — the
length rides in the overlapped struct (`from_len`) and the completion
path (`__yo_win_process_completion`) copies it back through the caller's
`out_fromlen` pointer. `WSASendTo`'s destination address is consumed at
call time and needs nothing.

The caller's `src_addr`/`addrlen`/buffer outlive the call the same way
`recv`'s buffer always has: they are owned by the suspended task's state
machine, which the await machinery keeps alive until the operation
completes (`std/net/udp.yo` allocates them in the task and awaits).

Regression test: `tests/net/udp.test.yo` "a quiet recv_from parks the
task, not the event loop" (the repro's assertions); the existing
send_to/recv_from round-trip tests in the same file cover the data path
and address decode.
