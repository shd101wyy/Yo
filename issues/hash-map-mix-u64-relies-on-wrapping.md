# `wrapping_mul`'s fallback loops `rhs` times — and `HashMap`'s mixer needs it on every insert

## Symptom

Any program that inserts into a `HashMap`, compiled by a compiler carrying
safe-mode 3 (#837), dies on the first insert. Two successive shapes:

1. With `mix_u64` unchanged (plain `*`): abort.
   `integer multiplication overflow (…/std/collections/hash_map.yo:68:10)`,
   rc=134.
2. After naively switching `mix_u64` to `wrapping_mul`: a de-facto hang —
   the process spins at 100% CPU indefinitely (a fresh two-key test binary
   burned 63 CPU-minutes without finishing).

Minimal reproducer (compiled with a #837-codegen binary, e.g. any binary
`yo build` produced on develop AFTER the seed catches up):

```rust
{ HashMap } :: import("std/collections/hash_map");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  m := HashMap(String, i32).new();
  m.insert(`hello`, i32(1));              // aborts (shape 1) or hangs (shape 2)
  println(m.get(`hello`).unwrap_or(i32(0)).to_string());
});
export(main);
```

## Root cause — two layers

**Layer 1: `mix_u64` (`std/collections/hash_map.yo` ~L65).** The fmix64
finalizer applied to every hash before bucket indexing multiplies by the
murmur3 constants, and a full-range u64 hash times a 64-bit constant
overflows u64 on essentially every call. Its own comment said the wrap is
by design ("`*` wraps on u64 overflow, as FNV-1a relies on") — but plain
`*` traps since safe-mode 3. `std/hash.yo` received the D1 sweep
(`wrapping_mul`/`wrapping_add` comments); `hash_map.yo` is the missed site.

**Layer 2: `wrapping_mul` (`std/prelude.yo`, the numeric trait family).**
Its checked_mul-failed fallback was REPEATED ADDITION:

```rust
(n : T) = … rhs …;
while(i < n, i = (i + T(1)), { acc = acc.wrapping_add(step); });
```

— O(rhs) iterations. Fine when `wrapping_mul` was cold (the comment said
"only reached on a path that already overflowed"); once layer 1 routed
every hash multiply through it, rhs = a full-range u64 → ~2^64 iterations
→ shape 2. The fix is 8-bit-lane school multiplication: only `&`, `>>`,
`!=`, `wrapping_add` (≤ 192 adds per call, O(1)), correct for signed T too
because masked lanes keep the two's-complement bytes and the arithmetic is
modular.

Why CI never saw either layer: trap codegen comes from the COMPILER, and
every compiler binary in the chain so far was built by the PRE-#837 seed
(`SEED_VERSION` = 0.2.39 predates it) — no binary used in CI contained the
checks. The first user program compiled by a #837-carrying binary trips
it. This is the seed-generation gap working exactly as
`plans/backlog/SEED_VERSION_AUTOMATION.md` describes: it ships with the
next release unless fixed at the source.

Remaining wide multiply/shift sites in std were checked by inspection:
UTF-8/UTF-16/JSON shifts are mask-bounded to valid ranges, `fmt`'s width
parsing multiplies stay small for real inputs, `hash.yo` already used the
D1 spellings.

## Fix

1. `mix_u64` (`std/collections/hash_map.yo`) → `h.wrapping_mul(...)` (×2).
2. `wrapping_mul` (`std/prelude.yo`) fallback → lane-based modular multiplication.
3. `fnv1a64` (`src/utils.yo` — the compiler's own inlined FNV-1a for stable
   ids, same wrap-by-design multiply, same missed site) →
   `wrapping_sub`.
4. The follow-up sweep found the same missed idiom in five more wrap-by-design
   subtractions, fixed the same way: PCG's rotate (`u32(0) - rot`) and both
   `threshold := (0 - bound) % bound` sites in `std/rand.yo`, the
   isolate-lowest-set-bit `x & (0 - x)` in `std/prelude.yo`'s popcount, and
   CRC's branchless mask in `std/crypto/crc32.yo`. Guarded sites were left
   alone (`std/string.yo`'s `i64(0) - mag` is bounded by the preceding
   `mag <= i64.MAX` check).

Test: `std/collections/hash_map.test.yo` — a string-keyed insert/get
round-trip. Before both fixes it aborts (shape 1) on any #837-codegen
compiler; between the fixes it hangs (shape 2); after both it passes.
Cross-checked the lane algorithm against Python-computed modular products
(fmix64(1), 0xDEADBEEFCAFEBABE × 0xFF51AFD7ED558CCD, 2^64−1 × 2, 0).

## Discovered while

`yo context` C2 (`plans/YO_CONTEXT.md`): the index builder's internal test
aborted with exit 6 in the test runner but passed standalone — whether an
overflow fires first is value-dependent (which hash overflows first
depends on the module paths), which made the bug look flaky before the
minimal repro.
