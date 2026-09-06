# `IpAddr.parse_v4` accepted empty octets, wrapping octets and leading zeros — three silent wrong values

**Status: FIXED 2026-09-06** (`std/net/addr.yo`). Found by the std API
stabilization audit (`plans/STD_API_STABILIZATION.md` §3 item 6).

**Severity: wrong value.** Not an error that could be caught — a *different
address*:

| input | parsed as | why |
| --- | --- | --- |
| `"..."` | `0.0.0.0` | three separators each hit the `.` arm with `val == 0`; nothing counted the digits in an octet |
| `"1.2.3."` | `1.2.3.0` | same — the trailing empty octet became 0 |
| `"4294967297.0.0.0"` | `1.0.0.0` | the accumulator `val * 10 + d` was range-checked only at the separator, after it had wrapped `u32` |
| `"01.2.3.4"` | `1.2.3.4` | leading zeros accepted; Rust's `Ipv4Addr::from_str` rejects them (octal ambiguity) |

`tests/net/addr.test.yo` covered `999.0.0.1`, `1.2.3` and `1.2.3.abc` — none of
these shapes.

## Fix

Count the digits in the current octet: a separator or the end of input with
zero digits is an error; a digit after a leading `0` is an error; the range
check runs after every digit, so the accumulator can never wrap.

## Regression tests

`tests/net/addr.test.yo`: three tests (empty octets ×5 shapes, wrapping
octets ×2, leading zeros ×2 plus `0.0.0.0` as the acceptance canary), red-first.

Still open for this function (P1 in the plan): it throws through `Exception`
with a stringly `NetError.Other` payload for a pure parse — D1 puts parsing on
`Result(T, TypedError)`; `AddrParseError` and `parse_v6`/`SocketAddr.parse`
are the follow-up.
