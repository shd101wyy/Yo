# IPv6 `to_string` emits `0:0:0:0:0:0:0:1` — no RFC 5952 `::` compression

**Status: FIXED 2026-09-14.** RFC 5952 section 4.2 implemented in the `.V6`
arm of the `ToString` impl; verified red-then-green against the repro and nine
new assertions in `tests/net/addr.test.yo`. Supersedes the duplicate filing
`issues/retired/stddoc-io-ipv6-to-string-is-not-rfc-5952-canonical.md`, which
recorded the same defect a week later from the doc sweep.

**Was: OPEN.** **Class**: api-lie — the canonical text form of an IPv6
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

---

## Fix (applied 2026-09-14)

Only section 4.2 was missing, exactly as this doc's root-cause analysis said —
4.1 (no leading zeros) and 4.3 (lowercase) already came free from `write_hex`
being `%llx`. The `.V6` arm now scans for the zero run to compress before
emitting:

- **4.2.1** — the longest run of consecutive all-zero fields becomes `::`.
- **4.2.3** — on a tie the FIRST run wins. That is a `>` rather than a `>=`
  when the best run is updated, and it is the whole difference between
  `2001:db8::1:0:0:1` and `2001:db8:0:0:1::1`.
- **4.2.2** — a run of a SINGLE zero field is never shortened; `1:0:2:…` must
  not become `1::2:…`.

`::` carries both colons, so a run touching either end renders correctly
(`::1`, `2001:db8::`, and `::` for the all-zero address); the separator is
suppressed for the field immediately after it.

`SocketAddr` needed no change — it brackets whatever `to_string` returns, so
`[2001:db8::1]:443` follows from the same fix, which is what this doc predicted.

### The misleading comment is corrected too

This doc flagged that `std/net/tcp.yo` told the next reader the uncompressed
form was *required* as `inet_pton` input, and measured that claim false. That
comment is now replaced with what is actually true — `inet_pton` accepts both
forms identically — and points at this record. It was the single most likely
thing to stop someone making this fix, which is why it mattered more than its
size. (`std/net/udp.yo` no longer carries that code path at all, so there was
nothing to correct there.)

The claim is also now covered by execution rather than by reading:
`tests/net/tcp.test.yo` (23 tests) and `tests/net/dns.test.yo` pass unchanged
against the compressed rendering, and those drive real `inet_pton`.

## Regression tests (added)

`tests/net/addr.test.yo`, nine assertions across two tests. **The expectations
are taken from RFC 5952 itself**, not from this doc — an expected-value list
written alongside a bug report is not an independent oracle, and two such
lists were found wrong elsewhere in this same clean-up pass. The tie-break row
is the RFC's own worked example, `2001:db8:0:0:1:0:0:1` → `2001:db8::1:0:0:1`.

Covered: loopback, all-zero, leading run, trailing run, the lone-zero case that
must NOT compress, longest-run-wins, first-run-wins-on-tie, a link-local
address that also pins 4.1/4.3, and both `SocketAddr` renderings.

Both tests fail against the pre-fix `std` (exit code 6); the 34 pre-existing
tests in the file are unaffected. Clean under the published v0.2.32 seed.

## Not done

RFC 5952 **section 5** — the mixed `::ffff:192.0.2.1` notation for
IPv4-mapped addresses — is not implemented; such an address still renders as
`::ffff:c000:201`. That is a further behaviour change to a shipped API and was
not what either filing asked for. Worth doing with the module's next stability
pass, alongside a `parse_v6` that accepts the same notation.
