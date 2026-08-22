# enum alignment ignored the C tag — structs embedding low-align-payload enums lost their tail padding (heap corruption)

**Status: FIXED 2026-08-22** (`src/types/utils.yo`, `get_alignment_of_type`
EnumT arm: alignment is now `max(4, max payload alignment)`).

## Symptom

PR #229's Linux legs (both, deterministically) died in
`tests/net/dns.test.yo` "resolve localhost returns socket addresses":

```
==8403==ERROR: AddressSanitizer: heap-buffer-overflow ... READ of size 24
0x5080000000f8 is located 0 bytes after 88-byte region
```

88 = 4 × 22 (the evaluator's `sizeof(SocketAddr)`), while the C `memcpy`
width/stride is 24 (clang's padded sizeof). ASan is non-functional on the
local macOS box (memory: asan-unusable-on-this-box), so local runs of the
same test were silently green.

## Root cause

`get_alignment_of_type`'s value-semantics EnumT arm returned only the max
alignment across variant PAYLOAD fields — but the C representation is

```c
struct __yo_tN_struct { __yo_tN_tag tag; __yo_tN_data data; };
```

with an int-typed tag (C enum: 4 bytes, 4-aligned). For
`IpAddr :: enum(V4(4×u8), V6(Array(u16, 8)))` the payload max-align is 2,
so the evaluator said align 2 while C says 4. The enum's own SIZE arm
already assumed the tag (`struct_align_bits = max(32, …)` — IpAddr sized
20 correctly), so the two functions disagreed: `SocketAddr :: struct(ip :
IpAddr, port : u16)` computed 20 + 2 = 22 with struct align 2 (no tail
padding), while C pads to 24. Every `sizeof`-based buffer computation over
such a struct (ArrayList element math first among them) then mixes a
22-byte stride with 24-byte C copies → heap overflow.

**TS parity note:** the attic `getAlignmentOfType` (utils.ts:1789) has the
IDENTICAL omission — this was a faithfully ported bug, and the fix is a
deliberate divergence (recorded at the fix site).

## Why it surfaced now

Nothing before S0 C3 ever put a V6 `IpAddr` into a `SocketAddr` list on an
ASan leg: `lookup_host` dropped all AAAA records, so `resolve(localhost)`
produced 3 all-V4 entries (reads stayed inside the undersized buffer).
The C3 fix made it 6 entries and the growth-copy read ran off the end.
The layout bug itself is old and independent of C3.

## Repro (minimal, no ASan needed — the sizes disagree directly)

```rust
IpA :: enum(V4(a : u8, b : u8, c : u8, d : u8), V6(segments : Array(u16, 8)));
SockA :: struct(ip : IpA, port : u16);
// pre-fix: sizeof(IpA) = 20 (correct), sizeof(SockA) = 22 (C: 24)
```

Gate: `tests/basic.test.yo` "enum tag participates in alignment"
(sizeof asserts + an ArrayList roundtrip that ASan legs verify at the
memory level). Verified red (22) before the fix, green (24) after.
