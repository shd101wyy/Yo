# `make_sockaddr_in` / `make_sockaddr_in6` discard `inet_pton`'s result — malformed IP text silently becomes `0.0.0.0` / `::`

**Status: OPEN.** **Class**: wrong-value — unparseable address text yields the
WILDCARD address instead of an error, so a caller binds every interface, or
connects to the wrong host, with nothing reported.

**Found**: 2026-09-04, measuring the `net` row of the std API audit.

## Symptom

Both sockaddr builders in `std/sys/tcp.yo` (a module whose `make_sockaddr_in`,
`make_sockaddr_in6`, `get_addr_in`, `get_family` are all in its export list at
`:211-237`) throw away the one value `inet_pton` uses to report failure.

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
open(import("std/string"));
open(import("std/fmt"));
IO_tcp :: import("std/sys/tcp");

probe :: (fn(txt : String) -> unit)({
  c := txt.to_cstr();
  sa := IO_tcp.make_sockaddr_in(c.ptr().unwrap(), u16(80));
  a := IO_tcp.get_addr_in(sa.buf);
  p := IO_tcp.get_port_in(sa.buf);
  unsafe(printf("  %-20s -> family=%d addr=0x%08x port=%d\n",
    txt.to_cstr().ptr().unwrap(), i32(IO_tcp.get_family(sa.buf)), a, i32(p)));
  IO_tcp.free_sockaddr(sa);
});

main :: (fn() -> unit)({
  probe(`127.0.0.1`);
  probe(`not-an-ip`);
  probe(``);
  probe(`999.999.999.999`);
});
export(main);
```

Observed (`yo 0.2.24`, `--std-path ./std --optimize 2`):

```
  127.0.0.1            -> family=2 addr=0x0100007f port=80
  not-an-ip            -> family=2 addr=0x00000000 port=80
                        -> family=2 addr=0x00000000 port=80
  999.999.999.999      -> family=2 addr=0x00000000 port=80
```

`0x00000000` is `INADDR_ANY`. The caller receives a fully-formed, correctly
sized `sockaddr_in` that says "every interface", and no signal that the text was
garbage. The v6 builder behaves identically — dumping the 16 address bytes from
`make_sockaddr_in6` + `get_addr_in6` gives all zeros (`::`) for input
`garbage`, next to the correct bytes for `::1` and `2001:db8::1`.

## Root cause

```rust
__yo_inet_pton(AF_INET,  ip, buf.add(usize(4)));   // std/sys/tcp.yo:132
__yo_inet_pton(AF_INET6, ip, buf.add(usize(8)));   // std/sys/tcp.yo:148
```

`inet_pton` returns `1` on success, `0` when the text is not a valid address of
that family, and `-1` (with `EAFNOSUPPORT`) for a bad family. Both call sites
evaluate it in statement position and drop it. The destination buffer was
already zero-filled by the loop just above each call (`:124-128` and
`:140-144`), so a failed conversion leaves exactly the wildcard address and is
indistinguishable from a caller that asked for it.

## Why nobody has hit it yet — and why it still has to be fixed

Both in-tree call paths render their text from an already-typed `IpAddr`
(`std/net/tcp.yo:36-55`, `std/net/udp.yo:34-51`), so today's inputs are always
well-formed. That makes this latent, not harmless: `make_sockaddr_in` is
exported std surface, and the moment user text reaches it — which the `net`
row's own `SocketAddr.parse` item makes attractive — a typo in a config file
turns a loopback-only service into a public one.

## Fix

`make_sockaddr_in` / `make_sockaddr_in6` must be able to fail. Two shapes; the
second is recommended.

1. Return `Result(SockAddr, IoError)`. Honest, but it changes the type of a
   function called from `std/net/tcp.yo`, `std/net/udp.yo` and
   `tests/net/*.test.yo`, and `SockAddr` is a plain value struct with an owned
   `malloc`'d buffer, so every caller grows a match.

2. **Recommended**: take the `Exception` effect, the way the rest of `std/net`
   already reports errors —
   `make_sockaddr_in : (fn(ip : *u8, port : u16, exn : Exception) -> SockAddr)`
   — and on `rc != 1` free the buffer and
   `exn.throw(dyn(IoError.from_errno(EINVAL)))`, i.e. the existing
   `NetError.check` / `_throw_net_io` path (`std/net/errors.yo`,
   `std/net/udp.yo:52-54`). The high-level wrappers already run inside an
   `io.async` body with `e.exn` in hand, so they need one extra argument each
   and no new control flow.

Do not "fix" this by validating the text in the caller — the check has to be
where the conversion is, or the next caller re-introduces it.

## Breaking change

Yes: `make_sockaddr_in` / `make_sockaddr_in6` gain a parameter (or change
return type), and text that silently produced `0.0.0.0` starts erroring. Both
are exported from `std/sys/tcp`, so it belongs in the release notes.

## Regression test

`tests/net/tcp.test.yo` (or a new `tests/net/sockaddr.test.yo` if the helpers
move to a shared module): `make_sockaddr_in` with `not-an-ip`, `""`,
`999.999.999.999`, `1.2.3` and `::1` (wrong family for AF_INET) must all throw;
`make_sockaddr_in6` with `garbage`, `""` and `1.2.3.4` (wrong family for
AF_INET6) must all throw; and the valid forms — `127.0.0.1`, `0.0.0.0`,
`255.255.255.255`, `::1`, `2001:db8::1` — must still produce the exact address
bytes, so the new rejection cannot over-reject.
