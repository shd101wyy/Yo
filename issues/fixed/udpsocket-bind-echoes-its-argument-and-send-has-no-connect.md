# `UdpSocket.bind` echoed its argument (an ephemeral bind reported port 0) and `send`/`recv` required a `connect` that did not exist

**Status: FIXED 2026-09-06** (`std/net/udp.yo`, `std/net/tcp.yo`). Found by the
std API stabilization audit (`plans/STD_API_STABILIZATION.md` §3 item 7).

## Two defects

1. **`bind` stored the bind ARGUMENT as `_local_addr`** (`udp.yo:87`). Binding
   port 0 — the only reason to bind port 0 — therefore reported port **0**
   forever, and there was no other way to learn the kernel-assigned port.
   `TcpListener.bind` was fixed for exactly this as C2 (`getsockname` readback,
   `tcp.yo:168-181`); UDP never received it. The existing test asserted only
   `la.ip.is_loopback()` and never looked at the port.
2. **`send` and `recv` said "requires prior connect" and no `connect` existed**
   anywhere in `std/net` — they were dead on arrival (`ENOTCONN`, always).

## Fix

- `bind` reads the bound address back with `SockInfo.getsockname`, decoding it
  through TCP's sockaddr decoder — exported from `std/net/tcp` as
  `sockaddr_to_socket_addr` (it was `_sockaddr_to_socket_addr`, private; one
  decoder for the whole `net` layer, and §1 forbids underscore names in
  `export(...)`).
- `UdpSocket.connect(addr, io)` — `connect(2)` on the datagram socket via the
  existing `IO_tcp.connect` future; Rust's `UdpSocket::connect`.

## Regression tests

`tests/net/udp.test.yo`: *bind to port 0 reports the kernel-assigned port*
(asserts `port != 0`) and *connect makes send and recv usable* (a connected
pair exchanging a datagram each way). Red-first: the second did not compile
(`connect` unresolved), which masked the first until the fix.

Still open (P1): `recv_from` hands back a raw `sockaddr` buffer instead of a
`SocketAddr` — the same decoder now makes `recv_from -> (n, from)` a small
change.
