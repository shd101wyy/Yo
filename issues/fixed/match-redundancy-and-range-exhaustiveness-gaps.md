# `match` misses collectively-redundant and range-subsumed arms, and a full `u8` range is not exhaustive

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 4).
**Status:** FIXED on `tss/phase4-5` (`plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 4.5). Completeness
of exhaustiveness/usefulness; follows the P1-P3 landing of `plans/MATCH_PATTERN_MATCHING.md`.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

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

## Fix

All in `src/pattern.yo`, reported from `src/evaluator/exprs/match.yo`.

- **Intervals.** At a fixed-width integer position every constant and range is a closed
  interval of *keys*: the value's 64-bit pattern for an unsigned type, with the sign bit
  flipped for a signed one, so key order is value order. `_useful_int` cuts the part of the
  domain the query matches at every row bound and asks each segment with the rows that match
  it (constructor splitting, as rustc does). `(0..=255)` covers `u8`; a gap is the witness,
  rendered `(101 ..= 149)`. `usize`/`isize` have a different range per target, so past their
  keys there is always a value only a catch-all matches, as in Rust.
- **Per-arm verdicts** (`arm_reachability`). The arm's whole pattern, then each alternative of
  a top-level or-pattern against the earlier arms plus its earlier siblings:
  - no value matches it → error (an empty range, a GADT variant the type excludes);
  - one earlier arm or alternative covers it → error, as before (now also for alternatives);
  - the earlier arms cover it together → warning, through the warnings channel.

  A trailing `_`/binding arm stays exempt.
- **Witnesses.** A variant renders every payload field (`.Circle(_)`). When counting guarded
  arms as if their guards held removes the witness, the E0607 error's help line says the guard
  is what leaves the value unmatched.
- **GADT.** A variant the scrutinee's index excludes has no values (`gadt_exact`). Inside a
  generic specialization the index is the instantiation's, so there the arm checks treat every
  variant as live; exhaustiveness still excludes them.

Found on the way and fixed: `issues/fixed/a-repeated-or-pattern-alternative-is-accepted.md`,
`issues/fixed/match-demands-a-missing-case-of-a-gadt-excluded-variant.md`.

## Tests

`tests/match_ranges.test.yo` (full-domain ranges run without `_`) and the cli-cases
`match-range-subsumed-by-an-earlier-range-is-an-error`, `match-arm-covered-by-earlier-arms-warns`,
`match-full-u8-range-is-exhaustive`, `match-integer-gap-is-the-missing-case`,
`match-usize-ranges-need-a-catch-all`, `match-empty-range-arm-is-an-error`,
`match-gadt-excluded-variant-arm-is-an-error`, `match-guard-leaves-the-missing-case`,
`match-missing-variant-witness-shows-its-payload`.
