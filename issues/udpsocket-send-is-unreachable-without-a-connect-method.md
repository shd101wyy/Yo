# `UdpSocket.send` is unreachable public surface — it documents a `connect` that does not exist

**Status: OPEN.** **Class**: api-lie — a documented public method that can
never succeed.

**Found**: 2026-09-04, measuring the `net` row of the std API audit.

## Symptom

`std/net/udp.yo:119-126` exposes

```rust
/// Send data on a connected socket (requires prior connect).
send : (fn(self : Self, data : ArrayList(u8), io : Io) -> Impl(Future(usize, IoExn)))(…)
```

There is no `connect` anywhere on the type. The impl block
(`std/net/udp.yo:66-169`) has `bind`, `send_to`, `recv`, `recv_from`, `send`,
`close`, `set_broadcast`, `local_addr`, `fd` — and `std/sys/udp.yo` exports no
`connect` either (its only two mentions of the word are comments at
`std/sys/udp.yo:59` and `:64`, both saying "after connect()"). So no API path
can put a `UdpSocket` into the connected state, and `send` can only ever fail.

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
{ ArrayList } :: import("std/collections/array_list");
open(import("std/string"));
open(import("std/fmt"));
{ UdpSocket } :: import("std/net/udp");
{ SocketAddr, IpAddr } :: import("std/net/addr");
{ Error, AnyError, Exception, IoExn } :: import("std/error");

main :: (fn(io : Io) -> unit)({
  exn := Exception(
    throw : (
      err -> {
        unsafe(printf("  send THREW: %s\n", err.to_string().to_cstr().ptr().unwrap()));
        unwind(());
      }
    )
  );
  sock := io.await(UdpSocket.bind(SocketAddr.loopback(u16(0)), io), IoExn(io : io, exn : exn));
  unsafe(printf("  bound fd=%d\n", sock.fd()));
  data := ArrayList(u8).new();
  data.push(u8(65));
  n := io.await(sock.send(data, io), IoExn(io : io, exn : exn));
  unsafe(printf("  send returned %zu\n", n));
});
export(main);
```

Observed (`yo 0.2.24`, `--std-path ./std --optimize 2`):

```
  bound fd=4
  send THREW: unknown I/O error
```

There is no input to this program that makes the `send returned …` line print.

It is also completely untested: `grep -n "\.send(" tests/net/udp.test.yo`
returns nothing — the UDP tests exercise `send_to` and `recv` only.

## Root cause

The wrapper was written against the BSD socket API's connected-datagram mode
but the `connect` half was never ported up from `std/sys`. The sys layer is not
even the blocker: `IO_tcp.connect` is already exported (`std/sys/tcp.yo:78-80`,
in the export list at `:216`) and `connect(2)` is valid on `SOCK_DGRAM` — it
just records a default peer and enables `send`/`recv`.

## Fix

Add the missing method rather than deleting `send`. In `std/net/udp.yo`:

```rust
/// Set the default peer for this socket, enabling `send`/`recv`.
connect : (fn(self : Self, addr : SocketAddr, io : Io) -> Impl(Future(unit, IoExn)))({
  fd := self._fd;
  io.async(e => {
    saddr := _make_sockaddr(addr);
    r := e.io.await(IO_tcp.connect(fd, saddr.buf, saddr.len), e.io);
    IO_tcp.free_sockaddr(saddr);
    cond((r < i32(0)) => { _throw_net_io(i32(0) - r, e.exn); }, true => ());
  })
})
```

built with the existing `_make_sockaddr` (`std/net/udp.yo:34-51`) and freed with
`IO_tcp.free_sockaddr`, exactly as `TcpStream.connect` does at
`std/net/tcp.yo:265-280`. Record the peer on the ref-struct at the same time so
a `peer_addr()` accessor becomes possible later.

Do NOT place a nested closure inside the `io.async` body — that shape is the
known-fragile one (`issues/async-cond-dispatch-skips-chained-sibling-arm.md`,
`issues/async-await-nested-if-lost-continuation.md`).

Also fix the doc comment on `send` once `connect` exists, so it points at a
real method: "Send data to the peer set by `connect`."

## A second, smaller thing this exposes

The error text above is `unknown I/O error`. `send(2)` on an unconnected
datagram socket returns `EDESTADDRREQ` on macOS and `ENOTCONN` on Linux;
`std/sys/errors.yo:88-124` maps `ENOTCONN` (`:115`) but has no
`EDESTADDRREQ` arm even though the constant is exported from
`std/libc/errno.yo:195`, so the macOS path falls into `.Other(errno)` — and
`.Other`'s message at `std/sys/errors.yo:173` is the literal string
`"unknown I/O error"`, which throws the errno away. Worth adding the arm (and
putting the errno number in the `.Other` message) while in here; neither is the
subject of this issue.

## Breaking change

No — `connect` is purely additive, and `send` keeps its signature.

## Regression test

`tests/net/udp.test.yo`:

- connect-then-`send`/`recv` round-trip between two loopback sockets (this is
  the test that makes `send` reachable for the first time);
- `connect` to a closed port, then `send` → the next `recv` reports
  `ConnectionRefused` (the connected-socket behaviour that `send_to` does not
  give you);
- `connect` to a `SocketAddr` on a socket bound to port 0, then `local_addr()`
  is still valid.
