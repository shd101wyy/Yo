# A folded comptime integer argument to a method is lowered to `i32` and rejected

**Status: FIXED 2026-09-25** (Phase 2.5 of `plans/TYPE_SYSTEM_SOUNDNESS.md`).

**Severity: false rejection, inconsistent between call paths.**

```rust
_f :: (fn(a : u8) -> u8)(a);
Holder :: struct(n : i32);
impl(Holder, g : (fn(self : Self, a : u8) -> u8)(a));
_f(100 + 50);   // accepted
h.g(100 + 50);  // error[E0601]: Cannot unify incompatible types: "u8" and "i32"
h.g(150);       // accepted
```

The out-of-range `h.g(200 + 100)` got the same unify error instead of the range diagnostic
(`the compile-time value 300 does not fit in u8`) that `_f(200 + 100)` reports.

## Root cause

`100 + 50` evaluates to a `comptime_int`: only a bare literal is typed directly by its expected
type. The method path lowered every `comptime_int` argument with the default lowering, to `i32`,
before unifying with the parameter. The free-function path checked the literal against the
declared type instead (it fits, so it is accepted; it does not fit, so it gets the range error).

## Fix

`check_argument_for_parameter` (`calls/helper.yo`) is shared by both paths. A comptime literal
that fits a concrete declared type lowers to THAT type, and a known `comptime_int` value is range
checked against it.

## Verification

`tests/type_soundness.test.yo`, "a folded comptime integer is judged the same on both call paths".
