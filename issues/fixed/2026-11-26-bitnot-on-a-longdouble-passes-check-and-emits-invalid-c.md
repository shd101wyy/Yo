# `~longdouble(1.0)` passes `yo check` and emits C that clang rejects

**Severity:** S2 — an invalid program is accepted by the evaluator and fails later as a C compiler error with no Yo diagnostic; `check` is green.

**Status:** fixed by VERDICTS-87 PR D (`wip/v0281-v87d`): the `longdouble` `BitNot` impl is deleted, and with it the `BitAnd`, `BitOr` and `BitXor` impls, which emitted C `&`, `|`, `^` on `long double` the same way (measured with the released v0.2.79: `longdouble(7.5) & longdouble(2.0)` passes `check`, clang: "invalid operands to binary expression ('long double' and 'long double')"). `longdouble` now has the bitwise surface of `f32` and `f64`: none. Test: `tests/prelude.test.yo`, "float bitwise operators are compile errors" (four `longdouble` rows).

**Found:** 2026-11-26, VERDICTS-87, probe `r4`.
**Measured:** `yo 0.2.79` built from develop (`~/Workspace/Yo-wt/v0280-p12/yo-out/x86_64-unknown-linux-gnu/bin/yo`), `--std-path` of develop `030d63040`.

## Symptom

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

main :: (fn() -> unit)({
  z := longdouble(1.0);
  w := ~z;
  println("ok");
});
export(main);
```

`yo check` exits 0 (only an unused-variable warning for `w`). `yo compile --optimize 1`:

```text
bin/r4-bitnot-longdouble.c:2229:73: error: invalid argument type 'long double' to unary expression
 2229 |   long double _file____home_temp_149159398665830313140 = ((long double)(~(__yo_v_z)));
      |                                                                         ^~~~~~~~~~~
bin/r4-bitnot-longdouble.c:2238:11: error: invalid argument type 'long double' to unary expression
 2238 |   return (~(__yo_v_self));
      |           ^~~~~~~~~~~~~~
2 errors generated.
yo: error: compile: C compiler failed (exit 1) on bin/r4-bitnot-longdouble.c
```

## Root cause

`std/prelude.yo` (~6932) gives `longdouble` a `BitNot` impl (`Output : longdouble`, `(~) : (self -> __yo_op_bit_complement(self))`). A complement of a floating-point type has no meaning and C has no `~` on `long double`. `f32` and `f64` have no `BitNot` impl; `longdouble` is the one float type that does.

## Fix

VERDICTS-87 PR D (`plans/backlog/STD_RUST_ALIGNMENT.md` §9): delete the `longdouble` `BitNot` impl, so `~z` is the usual "no matching call" error (E0610) at the use.

## Test to add with the fix

In `tests/prelude.test.yo` (or the operator test file that names `BitNot`): a negative-compile test (as `tests/` pins rejected programs today) that `~longdouble(1.0)` is rejected by the evaluator; it fails before the fix (accepted, then a C error).
