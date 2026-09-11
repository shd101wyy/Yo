# `lookup_host` returns every address once PER SOCKET TYPE (duplicates)

**Found:** 2026-09-11, during the `std/` `///` doc sweep (agent A4, net/http/io group).
**Status:** open. Filed, not fixed — the sweep is documentation-only.

## Behaviour, verbatim

`yo test ./tests/net/dns.test.yo --parallel 1 -v` on macOS (arm64), unchanged
tree:

```
  ✓ lookup_host localhost returns loopback
  addrs.len = 4
  addr[0] = 0:0:0:0:0:0:0:1
  addr[1] = 0:0:0:0:0:0:0:1
  addr[2] = 127.0.0.1
  addr[3] = 127.0.0.1
  ✓ resolve localhost returns socket addresses
  addrs.len = 4
  addr[0] = [0:0:0:0:0:0:0:1]:8080
  addr[1] = [0:0:0:0:0:0:0:1]:8080
  addr[2] = 127.0.0.1:8080
  addr[3] = 127.0.0.1:8080
  ✓ lookup_host returns IPv6 results (was: AAAA records dropped)
  addrs.len = 2
  addr[0] = 0:0:0:0:0:0:0:1
  addr[1] = 0:0:0:0:0:0:0:1
```

`localhost` has two addresses, not four. `::1` has one, not two.

## Root cause

`std/net/dns.yo:35-40` calls `getaddrinfo` with a NULL `hints`:

```rust
ret := e.io.await(IO_dns.getaddrinfo(host_cstr, .None, .None, result_ptr), e.io);
```

POSIX: with `hints` NULL (or `ai_socktype` 0) the resolver "shall return
entries for each supported socket type", so each resolved address comes back
once per socket type — two entries per address on macOS (`SOCK_STREAM` and
`SOCK_DGRAM`), three on glibc when `SOCK_RAW` is included. The result walk
(`std/net/dns.yo:48-88`) filters on `ai_family` only and pushes every entry, so
the duplicates reach the caller. `resolve` inherits them, one `SocketAddr` per
duplicate.

Rust does not have this problem because `ToSocketAddrs` passes
`ai_socktype = SOCK_STREAM` in its hints.

## Why it matters

The list is the caller's connect order. A caller that tries each address in
turn on failure retries the SAME address before moving to the next family, so
a host whose IPv6 route is black-holed waits out two IPv6 timeouts before
trying IPv4. A caller that round-robins over the list sends twice the traffic
to each address. Counting the list ("this host has 4 addresses") is simply
wrong, and the count is platform-dependent (2 vs 3 per address), so a test
that pins it passes on one OS and fails on the other.

## Fix sketch (not applied)

Pass a hints buffer with `ai_socktype = SOCK_STREAM` — the sys layer already
accepts one (`std/sys/dns.yo:54`, `hints : ?*u8`) and `std/sys/socket.yo` has
the constant. De-duplicating the output list would also work but hides the
cause and costs O(n²) or a `HashSet(IpAddr)`; the hints are what every other
resolver client does.

If a caller ever needs the datagram entries, the Rust-shaped answer is a
separate lookup that takes the socket type, not an unfiltered list.

Test coverage to add: `lookup_host(`localhost`)` yields no repeated `IpAddr`
(assert on distinctness, not on a fixed count — the address set is the
machine's), and `lookup_host(`::1`)` yields exactly one.
