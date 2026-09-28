# `MaybeUninit(T).new()` copies an indeterminate value (undefined behavior)

**Status: FIXED 2026-09-28** (found by the first full-suite UBSan run,
`plans/SAFE_MODE.md` D6/§14 R6; branch `safe-mode/callback-thunks`).

## Symptom

`tests/array.test.yo` "Test Array(T, N).default() builds N copies at RUN
TIME", run with `YO_TEST_SANITIZE=undefined`:

```
runtime error: load of value 3, which is not a valid value for type 'bool'
```

`Array(bool, N).default()` is safe code: the prelude builds the array through
`MaybeUninit(Self).new()`. Without UBSan the test passes, because every element
is overwritten before it is read.

## Root cause

The `BF_YO_MAYBE_UNINIT_NEW` arm (`src/codegen/exprs/inline_fns.yo`) emitted a
bare declaration, and the call's value was then copied into temporaries by
value:

```c
__yo_t_4305… __yo_uninit_r6972c27_n0;
__yo_t_4305… _file____User_temp_147… = __yo_uninit_r6972c27_n0;
__yo_t_4305… mu = _file____User_temp_147…;
```

Reading an indeterminate automatic object is undefined behavior (C11
6.3.2.1p2). With `bool` elements, clang lowers the copy to loads that carry the
`bool` range, and UBSan reports the garbage byte.

## Fix

The declaration is zero-initialized (`T __yo_uninit_… = {0};`). The copies now
read a defined value. The zeroing is a dead store whenever every byte is
written before being read, which is the `MaybeUninit` contract, and clang
removes it then. The in-tree uses are an `Array(i32, 2)` fd pair in `std/sys/tty.yo`
and `std/process/command.yo`, plus `Array(T, N).default()`.

## Verification

The full language suite under `YO_TEST_SANITIZE=undefined` reports no load of
an invalid value from this test. `.github/workflows/ubsan.yml` runs that suite
weekly and is the regression gate. An ordinary test cannot observe an
indeterminate read, because the program's output is the same either way.
