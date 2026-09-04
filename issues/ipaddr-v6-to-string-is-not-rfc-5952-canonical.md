# IPv6 `to_string` emits `0:0:0:0:0:0:0:1` — no RFC 5952 `::` compression

**Status: OPEN.** **Class**: api-lie — the canonical text form of an IPv6
address is wrong in every log line, error message and `SocketAddr` rendering.

**Found**: 2026-09-04, measuring the `net` row of the std API audit.

## Symptom

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
open(import("std/string"));
open(import("std/fmt"));
{ IpAddr, SocketAddr } :: import("std/net/addr");

show :: (fn(label : String, a : IpAddr) -> unit)({
  s := a.to_string();
  unsafe(printf("  %-14s -> %s\n", label.to_cstr().ptr().unwrap(), s.to_cstr().ptr().unwrap()));
});

main :: (fn() -> unit)({
  show(`::1`, IpAddr.loopback_v6());
  segs := Array(u16, usize(8)).fill(u16(0));
  segs(usize(0)) = u16(8193);       // 0x2001
  segs(usize(1)) = u16(3512);       // 0x0db8
  segs(usize(7)) = u16(1);
  show(`2001:db8::1`, IpAddr.V6(segs));
  z := Array(u16, usize(8)).fill(u16(0));
  show(`::`, IpAddr.V6(z));
  sa := SocketAddr.new(IpAddr.V6(segs), u16(443));
  ss := sa.to_string();
  unsafe(printf("  sockaddr       -> %s\n", ss.to_cstr().ptr().unwrap()));
  sl := SocketAddr.new(IpAddr.loopback_v6(), u16(443));
  sls := sl.to_string();
  unsafe(printf("  sockaddr ::1   -> %s\n", sls.to_cstr().ptr().unwrap()));
});
export(main);
```

Observed (`yo 0.2.24`, `--std-path ./std --optimize 2`):

```
  ::1            -> 0:0:0:0:0:0:0:1
  2001:db8::1    -> 2001:db8:0:0:0:0:0:1
  ::             -> 0:0:0:0:0:0:0:0
  sockaddr       -> [2001:db8:0:0:0:0:0:1]:443
  sockaddr ::1   -> [0:0:0:0:0:0:0:1]:443
```

Expected, per RFC 5952 §4.2: `::1`, `2001:db8::1`, `::`, `[2001:db8::1]:443`,
`[::1]:443`.

## Root cause

`std/net/addr.yo:155-169`, the `.V6(segs)` arm of the `ToString` impl, joins all
eight groups unconditionally:

```rust
w := Writer.new();
i := usize(0);
while(runtime(i < usize(8)), {
  cond((i > usize(0)) => { w.write_str(":"); }, true => ());
  w.write_hex(u64(segs(i)));
  i = (i + usize(1));
});
w.to_string()
```

`write_hex` (`std/fmt/writer.yo:107-113`) is `snprintf("%llx")`, so RFC 5952
§4.3 (lowercase) and §4.1 (no leading zeros) are already satisfied. Only §4.2,
the single `::` run, is missing. The bracketing in the `SocketAddr` impl
(`std/net/addr.yo:215`) is already correct per RFC 3986 §3.2.2 / RFC 5952 §6 —
the bracketed text is simply the uncompressed string.

## The comments that say the uncompressed form is required are wrong

`std/net/tcp.yo:46-49` and `std/net/udp.yo:42-45` both build the sockaddr by
rendering `addr.ip.to_string()` into `inet_pton`, with the comment

> Render the real address text (full uncompressed hex form — valid inet_pton
> input).

That parenthetical is false and will stop the next reader from fixing this.
`inet_pton(AF_INET6, …)` accepts the compressed form identically — measured
through the public `std/sys/tcp` exports:

```
  0:0:0:0:0:0:0:1          -> 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01
  ::1                      -> 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01
  2001:db8::1              -> 20 01 0d b8 00 00 00 00 00 00 00 00 00 00 00 01
  2001:db8:0:0:0:0:0:1     -> 20 01 0d b8 00 00 00 00 00 00 00 00 00 00 00 01
```

(byte dumps of `make_sockaddr_in6` + `get_addr_in6`). Compressing is safe; both
comments must be corrected in the same change so the claim does not outlive the
bug.

## Fix

Rewrite the `.V6` arm of `std/net/addr.yo:155-169`:

1. Scan the eight segments for the longest run of zeros.
2. RFC 5952 §4.2.2: do not compress a run of length 1 — `1:0:2:3:4:5:6:7` stays
   as it is.
3. RFC 5952 §4.2.3: on a tie, take the leftmost run.
4. Emit lowercase-hex groups elsewhere, with exactly one `::` for the chosen
   run (`::` alone for the all-zero address, and a trailing/leading `::` when
   the run touches an end).

Keep `Writer` rather than a fixed `Array(u8, 46)` + `snprintf`, so there is no
buffer-size question.

**Design choice — the IPv4-embedded form.** RFC 5952 §5 permits, and Rust's
`Display` emits, `::ffff:192.0.2.1` / `::a.b.c.d` for IPv4-mapped and
IPv4-compatible addresses rather than `::ffff:c000:201`. Recommend matching
Rust: `parse_v6` has to accept the dotted tail anyway for round-tripping, and
`inet_pton` accepts it. State the decision in the doc comment either way.

**Sequencing.** Land this together with `parse_v6` (the same audit row): a
parse↔to_string round-trip over one table is the only honest test of either
half, and splitting them means writing the expected-string table twice.

## Breaking change

Yes — every `IpAddr`/`SocketAddr` v6 string changes shape. Nothing in the tree
pins the current form (`tests/net/addr.test.yo:21-26` asserts only
`is_loopback()`/`is_v6()`, never the string; `tests/net/dns.test.yo:35`, `:74`,
`:102` merely print it), but downstream code that string-matches will see the
change, so it belongs in the release notes.

## Regression test

`tests/net/addr.test.yo`: `::`, `::1`, `2001:db8::1`, `1::8`,
`1:2:3:4:5:6:7:8` (nothing to compress), `1:0:2:0:0:3:0:0` (leftmost-longest →
`1:0:2::3:0:0`), `0:0:1:0:0:0:0:0` (→ `::1:0:0:0:0:0`), a single-zero run that
must NOT compress, and `SocketAddr` → `[::1]:443`.

Then re-run `tests/net/tcp.test.yo` and `tests/net/udp.test.yo` — in particular
`tests/net/tcp.test.yo:254` and `tests/net/udp.test.yo:141` ("bind to a
non-local IPv6 address must fail"), which guard the earlier fix that made
`_make_sockaddr` render the real address instead of hardcoding `::1`; they are
the tests that prove the sockaddr path still sees the right bytes.
