# A comptime float converted to an integer type keeps its float text

**Severity:** S2 — `i32(f32(100.5))` at compile time is an unreadable value, so comparisons with it are `<unknown>` and `comptime_assert`s on it pass vacuously

**Status:** FIXED 2026-09-29 (branch `tss/impl-self-operator`).
**Found:** the `yo check --test-bodies` census (`plans/TYPE_SYSTEM_SOUNDNESS_HANDOVER.md` §3.3,
site #8): `tests/comptime.test.yo:62` failed strict with `Expected bool value for
"comptime_assert" … <unknown: bool>`. The default check accepts an unknown condition, so the
assertion had never checked anything.

## Symptom (measured, develop `c52ce152c` and the Phase 3 step 7 branch)

```rust
a :: f32(100.5);
b :: i32(a);
comptime_assert(b == i32(100), "f32 -> i32 folds");
```

```
error[E1101]: Expected bool value for "comptime_assert", got:
b == i32(100)
Value:
<unknown: bool>
```

`f64(a)` folds; an integer target does not.

## Root cause

Case 1 of the numeric-type call (`src/evaluator/calls/numeric_type.yo`) passes the comptime
source's raw text to `_make_comptime_info`, which wraps it as `IntLit(raw)` for any non-float
target. For a float source that text is `"100.5"`: an integer literal that is not an integer,
which `parse_raw_int` rejects, so every operation on it degrades to an unknown value.

## Fix

`_float_raw_to_int_raw` converts the float as the runtime C cast does: it truncates toward zero.
A value the C conversion cannot represent is an error: NaN, an infinity, or anything outside
64 bits, all undefined behaviour in C, and anything outside the target type's range (E1102,
`check_comptime_int_value_fits`).

## Test

`tests/comptime.test.yo`, "comptime float to integer conversion truncates toward zero" (f32→i32,
negative values, the top of `u8`, a `u64` value beyond `i64`, and three rejections), plus the
existing `f32_to_i32` assertion, which now checks something.
