# `IpAddr.to_string()` renders IPv6 uncompressed, not in the RFC 5952 canonical form

**Found:** 2026-09-11, during the `std/` `///` doc sweep (agent A4, net/http/io group).
**Status:** open. Filed, not fixed — the sweep is documentation-only.

## Behaviour, verbatim

`issues/repros/stddoc-io-ipv6-to-string-is-not-rfc-5952-canonical.yo`, compiled
with `yo compile … --optimize 2 --std-path ./std`:

```
0:0:0:0:0:0:0:1
2001:db8:0:0:0:0:0:1
```

Expected (Rust's `Ipv6Addr::to_string`, `inet_ntop`, and every other tool that
prints an IPv6 address):

```
::1
2001:db8::1
```

The same divergence is visible in the existing test output —
`yo test ./tests/net/dns.test.yo -v` prints `addr[0] = 0:0:0:0:0:0:0:1` for the
`::1` literal it just resolved.

## Root cause

`std/net/addr.yo:582-614`, the `ToString` impl for `IpAddr`. The `.V6` arm
unconditionally writes all eight groups separated by `:`:

```rust
.V6(segs) => {
  w := StringBuilder.new();
  i := usize(0);
  while(runtime(i < usize(8)), {
    cond((i > usize(0)) => { w.write_str(":"); }, true => ());
    w.write_hex(u64(segs(i)));
    i = (i + usize(1));
  });
  w.to_string()
}
```

There is no zero-run compression. RFC 5952 §4.2.1/§4.2.2 make `::` MANDATORY
for the longest run of two or more zero groups (§4.2.3 breaks a tie in favour
of the leftmost run), and §4.1 forbids leading zeros in a group — the leading
zeros are already handled by `write_hex`, and §4.3's lower-case rule is
already satisfied, which is what makes the missing §4.2 conspicuous: the file
cites RFC 5952 for the case rule (`_hex_digit`, `std/net/addr.yo:28-30`) while
not implementing its compression rule.

## Why it matters

Text is how addresses cross tool boundaries. A Yo program that logs a peer
address emits `0:0:0:0:0:0:0:1` where the peer's own logs, an allow-list, a
`grep`, or a `HashSet(String)` of addresses all spell `::1`, so the two never
compare equal and de-duplication silently fails. It is the wrong-value class,
not a cosmetic one: `IpAddr` itself has `Eq`/`Hash`, but any comparison that
goes through the rendered form is broken.

## Fix sketch (not applied)

Compress the leftmost longest run of ≥2 zero groups in the `.V6` arm, and
handle the IPv4-mapped form (`::ffff:a.b.c.d`, RFC 5952 §5) if that is wanted
at the same time.

Two things a fixer should know:

- **The parser already accepts the compressed form** (`IpAddr.parse_v6` takes
  all three RFC 4291 §2.2 forms, and rejects a `::` in an address that already
  spells eight groups), so a round-trip through `to_string` → `parse_v6` keeps
  working — and starts round-tripping through OTHER tools too.
- **`std/net/tcp.yo`'s `make_sockaddr` feeds `to_string()`'s output to
  `inet_pton`** (`std/net/tcp.yo:47-56`, "full uncompressed hex form — valid
  inet_pton input"). `inet_pton` accepts the compressed form as well, so the
  change is safe there, but that comment must be updated with it or the next
  reader will re-introduce the uncompressed form on purpose.

Test coverage to add: a `to_string` assertion per RFC 5952 case (`::`, `::1`,
a middle run, a tie between two equal runs, an address with no zero run), and
a `parse_v6(to_string(x)) == x` round-trip over those.
