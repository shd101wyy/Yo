# `%` on a `longdouble` passes `yo check` and emits C `%`, which clang rejects

**Severity:** S2 — a valid program (`longdouble` implements `Rem`) passes `check` and fails as a C compiler error with no Yo diagnostic.

**Found:** 2026-11-26, lane v81-v87-ad (VERDICTS-87 PR D), while deleting `longdouble`'s bitwise impls.
**Measured:** the released `yo 0.2.79` with its bundled std.

## Symptom

```yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  a := longdouble(7.5);
  r := (a % longdouble(2.0));
  println(`${f64(r)}`);
});
export(main);
```

`yo check` exits 0. `yo compile --optimize 1`:

```text
ldrem.c:2377:70: error: invalid operands to binary expression ('long double' and 'long double')
 2377 |   long double _file____home_temp_115071040393593758770 = ((__yo_v_a) % (((long double)(2.0))));
      |                                                           ~~~~~~~~~~ ^ ~~~~~~~~~~~~~~~~~~~~~~
1 error generated.
yo: error: compile: C compiler failed (exit 1) on ldrem.c
```

## Root cause

`std/prelude.yo` gives `longdouble` `Rem(longdouble)` with `(%) : ((lhs, rhs) -> __yo_op_mod(lhs, rhs))`, the body `f32` and `f64` use. The codegen of `__yo_op_mod` (`src/codegen/exprs/inline-fns.yo`, ~353–370) emits `fmodf` for `f32`, `fmod` for `f64`, and C's `%` for everything else; `long double` falls into the integer arm. The comptime side was not checked.

## Fix

Emit `fmodl` for `longdouble` in that `cond` (an `is_longdouble_type` arm beside `is_f64_type`), so `%` is the truncated remainder on every float type.

## Test to add with the fix

A runtime row in the operator tests: `longdouble(7.5) % longdouble(2.0)` is `1.5` and `longdouble(-7.5) % longdouble(2.0)` is `-1.5`. It fails before the fix at C compile time.
