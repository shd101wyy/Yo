# `make_sockaddr_in` / `make_sockaddr_in6` discard `inet_pton`'s result — malformed IP text silently becomes `0.0.0.0` / `::`

**Status: FIXED** 2026-09-15. **Class**: wrong-value — unparseable address text
yielded the WILDCARD address instead of an error, so a caller bound every
interface, or connected to the wrong host, with nothing reported.

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

## Fix — AS APPLIED (option 1, not the option 2 this doc recommended)

`make_sockaddr_in` / `make_sockaddr_in6` now return
`Result(SockAddr, IoError)`; `rc != 1` frees the buffer and returns
`.Err(IoError.from_errno(EINVAL))`, so nothing is allocated for the caller to
free on the error path. `std/net/tcp.yo`'s shared `make_sockaddr` grew an
`exn : Exception` parameter and converts — `.Err(err)` becomes
`exn.throw(dyn(NetError.from_io(err)))` — so the `net` layer keeps throwing
`NetError` like every other failure there, and its five call sites in
`std/net/tcp.yo` and `std/net/udp.yo` pass `e.exn` (all five are already inside
`io.async(e => …)` bodies, so none of them grew control flow).

**Why option 1 and not the recommended option 2.** Two of this doc's premises
did not survive re-measurement on 2026-09-15:

- The cost it feared for option 1 — "every caller grows a match" — does not
  exist. There are exactly TWO call sites of the sys-level builders, and both
  are inside the single `make_sockaddr` helper; `std/net/udp.yo` routes through
  that helper rather than carrying its own copy, and no test calls them
  directly. So option 1 costs one match, in one function.
- Option 2's cost is larger than it looks. `std/sys/tcp.yo` reports every other
  failure as a raw negative errno resolved by an `IoFuture` — an `Exception`
  parameter would have made these two the ONLY throwing functions in a module
  of twenty, and pulled `std/error` into the sys layer. `std/sys/errors.yo`
  already has `IoError.from_result : (fn(i32) -> Result(i32, IoError))`, which
  IS this layer's stated convention.

The doc's actual constraint — "the check has to be where the conversion is, or
the next caller re-introduces it" — is satisfied either way: the check is in
the builder, only the reporting channel differs.

The two shapes as originally weighed:

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

Yes, and it shipped as one: `make_sockaddr_in` / `make_sockaddr_in6` return
`Result(SockAddr, IoError)` rather than `SockAddr`, and text that silently
produced `0.0.0.0` now errors. Both are exported from `std/sys/tcp`, so it
belongs in the release notes. `std/net`'s public surface is unchanged — the
conversion happens inside `make_sockaddr`.

## Regression test

Four tests in `tests/net/tcp.test.yo`, exactly the matrix this doc asked for.
`make_sockaddr_in` returns `.Err` for `not-an-ip`, `""`, `999.999.999.999`,
`1.2.3` and `::1` (wrong family for AF_INET); `make_sockaddr_in6` returns
`.Err` for `garbage`, `""` and `1.2.3.4` (wrong family for AF_INET6).

The over-rejection half matters as much and is easy to get wrong: `0.0.0.0` is
a LEGITIMATE request for the wildcard address and must still succeed. That is
the precise distinction the old code could not express — a caller asking for
`INADDR_ANY` and a caller whose config had a typo received byte-identical
results. `127.0.0.1` and `255.255.255.255` are compared against
`htonl(host-order value)` rather than a hardcoded word, so the test does not
silently encode the host's endianness.

Measured before the fix on the 2026-09-15 tree, confirming the doc's 2026-09-04
observation still held:

```
  127.0.0.1            -> family=2 addr=0x0100007f
  not-an-ip            -> family=2 addr=0x00000000
                       -> family=2 addr=0x00000000
  999.999.999.999      -> family=2 addr=0x00000000
```

and after:

```
  v4 127.0.0.1         -> Ok addr=0x0100007f port=80
  v4 0.0.0.0           -> Ok addr=0x00000000 port=80
  v4 255.255.255.255   -> Ok addr=0xffffffff port=80
  v4 not-an-ip         -> Err
  v4 (empty)           -> Err
  v4 999.999.999.999   -> Err
  v4 1.2.3             -> Err
  v4 ::1               -> Err
  v6 ::1               -> Ok family=30
  v6 2001:db8::1       -> Ok family=30
  v6 garbage           -> Err
  v6 (empty)           -> Err
  v6 1.2.3.4           -> Err
```
