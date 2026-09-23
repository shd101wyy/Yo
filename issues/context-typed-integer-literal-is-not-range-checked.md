# An integer literal typed by context is not range-checked, so it truncates silently

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 1).
**Status:** OPEN. Silent wrong value.
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
