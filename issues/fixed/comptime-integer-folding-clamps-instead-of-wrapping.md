# Compile-time integer folding clamps instead of wrapping or trapping

**Found:** 2026-09-24, while fixing
`issues/fixed/context-typed-integer-literal-is-not-range-checked.md` (Phase 1.4 of
`plans/TYPE_SYSTEM_SOUNDNESS.md`).
**Status:** FIXED 2026-09-24 in the same change.
**Class:** silent wrong value. Compile time disagreed with run time on constants, against the
documented rule that "the same expressions on constants are compile errors" (`docs/*/DESIGN.md`,
"Arithmetic and Failure Semantics").

## Symptom (MEASURED on develop `251522b21`, v0.2.41 seed)

| Constant | Folded to | Run time |
| --- | --- | --- |
| `i32(1) << 31` | `2147483647` | `-2147483648` (the bit shifted into the sign) |
| `i32(1) << 40` | `2147483647` | abort: `shift count out of range: 40 not in [0, 32)` |
| `y := (1 << 40)` (`1` defaults to `i32`) | `2147483647` | same abort |
| `-(i8(-128))` | `127` | abort: `integer negation overflow` |
| `i32(-2147483648) / i32(-1)` | `2147483647` | abort: `integer division or remainder by zero (MIN / -1)` |

`yo check` and `yo compile` were green for all of them, and the binary printed the folded value.

## Root cause

`src/evaluator/builtins/comptime_numeric_fns.yo`:

- `apply_bounds`, which `make_int_val` applies to every folded result, CLAMPED signed values to the
  type's range and took `|n| mod 2^w` for unsigned ones. `add`/`sub`/`mul` are checked for overflow
  before it runs, so the clamp only ever touched the operations that were not checked: shifts,
  negation, division.
- The shift branch computed `a << b` in `i64` with no count check. A count of 64 or more would
  also have trapped inside the compiler itself (safe-mode shifts).
- Negation and division had no `MIN` checks.

## Fix

- `apply_bounds` wraps two's-complement to the type's width (`comptime_int_width`: the declared
  bits, the target pointer width for `usize`/`isize`), the run-time behaviour of a left shift.
- Shifts: a count outside `[0, width)` is E1102 (`shift count 40 is out of range for i32 (0..32)`);
  a `comptime_int` left shift whose value leaves the i64 carrier is E1102.
- Negation of a signed type's `MIN`, and `MIN / -1` and `MIN % -1`, are E1102.

`(1 << 40)` is an error rather than `1 << 40 == 2^40` because a bare literal on the left of an
operator `comptime_int` does not implement defaults to `i32`; giving `comptime_int` shift
operators would break `1 << n` for a runtime `n` (the receiver problem of
`issues/an-integer-literal-on-the-left-of-a-runtime-operand-is-rejected.md`), so that is left to
that issue.

## Verification

The table's constants now fold to `-2147483648` or fail with E1102; in-range folds are unchanged
(`u8(255) << 1 == 254`, `u64(1) << u64(63) == 9223372036854775808`, `i8(-1) & i8(127) == 127`).
`tests/comptime_overflow.test.yo` gains the rejections and the wrap canaries.
