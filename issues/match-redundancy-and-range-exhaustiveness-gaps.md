# `match` misses collectively-redundant and range-subsumed arms, and a full `u8` range is not exhaustive

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 4).
**Status:** OPEN. Completeness of exhaustiveness/usefulness; follows the P1-P3 landing of
`plans/MATCH_PATTERN_MATCHING.md`.
**Measured:** yo 0.2.39 seed.

## Repros

```rust
(o : Option(bool)) = .Some(true);
x := match(o, .Some(true) => 1, .Some(false) => 2, .Some(_) => 3, .None => 4);  // accepted; .Some(_) is unreachable

(n : i32) = 5;
y := match(n, (0..10) => 1, (5..=7) => 2, _ => 3);  // accepted; (5..=7) is unreachable

(m : u8) = 5;
z := match(m, (0..=255) => 1);  // rejected: E0607 demands a `_`
```

Also measured:

- Witnesses are imprecise: `.Circle(r : 1), .Rect(...)` reports `Missing case: .Circle` rather
  than `.Circle(r : _)`. A guarded arm reports `Missing case: .Some` with no mention of the guard.
- A GADT-unreachable arm (`.BoolVal` in a `Value(i32)` match) is silently accepted.

## Context

`docs/en-US/DESIGN.md` §Pattern Matching says "An arm no value can reach is an error". The
plan's deviation 2 narrowed that to single-arm subsumption because "Yo has no warnings channel";
the warnings channel has since landed (#846), so collective redundancy can be a warning.

## Fix direction

1. Run the full usefulness check per arm (arm `i` is useful against arms `0..i-1`) and report
   non-useful arms through the warnings channel.
2. Model integer ranges as intervals so subsumption and full-domain coverage (`0..=255` on `u8`)
   are decided exactly.
3. Print witnesses with their payload wildcards and mention guards.
4. Update DESIGN.md to the implemented rule.
