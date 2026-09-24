# An integer literal typed by context is not range-checked, so it truncates silently

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 1).
**Status:** FIXED 2026-09-24 (Phase 1.4 of `plans/TYPE_SYSTEM_SOUNDNESS.md`). Originally OPEN: silent wrong value.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro

```rust
{ println } :: import("std/fmt");
f :: (fn(a : u8) -> u8)(a);
main :: (fn() -> unit)({
  (y : u8) = 300;
  println(`${y}`);      // prints 44
  println(`${f(300)}`); // prints 44
});
export(main);
```

Both lines pass `yo check` and print `44`. The audit also saw `u8(300)` print `44` and
`u32(i32(-1))` print `4294967295`. The reverse mistake, `(z : u8) = -1`, is rejected for the
wrong reason: `Expected "u8" Given "i32"`, because prefix `-` on a `comptime_int` yields `i32`.

## Mechanism (READ)

- `src/evaluator/values/integer.yo` (~67-81): when `expected_type` is one of the fixed-width
  integer types the literal simply takes that type. No bounds check runs on this path.
- The bounds helper `get_numeric_bounds` (`src/evaluator/calls/numeric_type.yo` ~175-197) exists
  but is reached only from some explicit-cast paths.

## Fix direction

In the literal evaluator, when the expected type is a fixed-width integer, check the value
against `get_numeric_bounds` and raise a coded error naming the type and its range. Make prefix
`-` on a `comptime_int` stay `comptime_int`. Decide separately whether `u8(300)` is a checked
conversion (it should be, for a literal argument) and whether `u32(i32(-1))` needs a spelled
`wrapping`/`bitcast` form.

## Root cause (confirmed)

Three separate gaps, all "a comptime integer reaches a fixed-width slot unchecked":

1. `values/integer.yo` typed a literal by its context and never looked at the value.
2. The negative-literal pre-fold (`calls/function.yo`, `-(IntLit)`) always produced a
   `comptime_int`, which the slot then defaulted to `i32` and rejected with the wrong message
   (`Expected: u8, Given: i32` for `-1`; the same for a valid `(y : i8) = -128`).
3. A folded `comptime_int` expression (`(200 + 100)`) was ADOPTED as the context type by the call
   machinery (`try_to_call_function_with_arguments`: "when the return type is compatible with
   the caller's expected type, adopt the expected type"), so it reached the slot as a `u8`
   holding 300. The comptime-int widening in `are_types_compatible` is value-blind.

## Decision

A `comptime_int` (literal, `::` constant or folded expression) entering a fixed-width integer
slot must fit it, whether the slot is a binding, an assignment, an argument, a struct or enum
field, a return value, a joined `cond`/`match` arm, or a `T(x)` conversion. A conversion between
two TYPED integers (`u32(i32(-1))`, `u8(some_i32)`) keeps the documented truncating semantics
(`docs/*/DESIGN.md`, "Arithmetic and Failure Semantics") at compile time as at run time, so it is
not checked. Out of range is E1102.

## Fix

- `src/types/utils.yo`: `target_integer_type_range` (usize/isize at the target's pointer width),
  `integer_value_fits_type` (sign + magnitude, so a u64 above `i64::MAX` is exact),
  `integer_type_range_string`.
- `src/evaluator/values/integer.yo`: `check_literal_fits` (the literal site), and
  `comptime_int_value_misfit` / `check_comptime_int_value_fits` / `comptime_numeric_slot_type`
  for a `comptime_int` VALUE. A negative raw value bound for a 64-bit unsigned target is accepted:
  it may be the i64 bit pattern of a value above `i64::MAX`.
- Call sites: the negative-literal pre-fold takes a fixed-width context type; the typed binding
  and both assignment paths (`exprs/assignment.yo`, `_comptime_numeric_into_slot`, which also makes
  `x :: 3; (y : u8) = x` legal), the annotated initialization, struct/enum fields
  (`calls/type.yo`), the argument binding loop (`calls/function.yo`), the concrete E0604 result
  check (`calls/function_type.yo`), the `cond`/`match` arm join, and `T(comptime_int)`
  (`calls/numeric_type.yo`, whose dead `_int_raw_in_range` bounds call is removed).
- `src/evaluator/calls/helper.yo`: a `comptime_int` call result is no longer adopted as the
  context type; it stays comptime until the slot coerces it.

## Verification

`(y : u8) = 300`, `f(300)`, `(z : u8) = -1`, `u8(300)`, `(y : u8) = (200 + 100)`, `f(200 + 100)`,
`P(x : (200 + 100))` and `x :: 300; (y : u8) = x` are E1102 naming `u8 (0..=255)`; `(y : i8) =
-128`, `(y : u64) = 18446744073709551615`, `(y : i64) = -9223372036854775808`, `x :: 3; (y : u8) =
x`, `(y : f64) = (1 + 2)` and `u32(i32(-1))` compile. Both directions are cases in
`tests/type_soundness.test.yo`.

Found alongside: comptime folding CLAMPED instead of wrapping or trapping (`i32(1) << 31` folded to
`i32::MAX`, `i32(1) << 40` too, `-(i8(-128))` was accepted), fixed as
`issues/fixed/comptime-integer-folding-clamps-instead-of-wrapping.md`. Not changed: `(y : usize) =
(1 << 40)` is rejected (the literal receiver `1` of an operator `comptime_int` does not implement
defaults to `i32`, and the shift count is now reported as out of range for `i32`); that is the
receiver half of `issues/an-integer-literal-on-the-left-of-a-runtime-operand-is-rejected.md`.
