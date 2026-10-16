# `MaybeUninit(Array(T, 0)).new()` emits a C initializer clang rejects

**Severity:** S2: a valid program is rejected (at C compile time, after a green
`yo check`). `Array(T, 0).fill(x)` and `Array(T, 0).default()` fail to compile,
and so does every `clone` of an `Array(T, 0)` once the `Array` `Clone` impl
builds its result through `MaybeUninit`.

**Status: FIXED** 2026-10-16 (`fix/collection-clone-through-borrow`). Found
while fixing `issues/fixed/array-clone-copies-self-out-of-the-borrow.md`:
`tests/derive.test.yo`'s "derive over an Array of length 0" clones a
`struct(cells : Array(i32, 0), tag : i32)`, and its batch stopped compiling.
**Measured on:** develop's std (0684c9c40) with the develop-built 1a4cf8df6
compiler.

## Symptom

```yo
main :: (fn() -> unit)({
  a := Array(i32, usize(0)).fill(i32(1));
  b := Array(i32, usize(0)).default();
});
export(main);
```

```text
tmp/r4.c:1972:57: error: initializer for aggregate with no elements requires explicit braces
  __yo_t_1814774088880985397 __yo_uninit_r7198c27_n0 = {0};
yo: error: compile: C compiler failed (exit 1) on tmp/r4.c
```

## Cause

The `BF_YO_MAYBE_UNINIT_NEW` arm (`src/codegen/exprs/inline_fns.yo`) declares
the storage as `T __yo_uninit_… = {0};`, a zero initializer added by
`issues/fixed/maybe-uninit-new-copies-an-indeterminate-value.md` so the copies
that follow read a defined value. `{0}` initializes the first scalar of `T`.
`Array(i32, 0)` is `typedef struct { int32_t data[0]; } Array_int32_t_0;`,
which has no scalar to initialize, so clang rejects the initializer.

## Fix

The storage is zeroed with `memset(&x, 0, sizeof(x))` after a bare
declaration, which is defined for every C type, including one with no
elements. The UB fix's guarantee is unchanged: the copies still read zeroed
bytes, and clang still removes the zeroing when every byte is written before a
read.

**Test:** `tests/array.test.yo`, "Array Clone, fill and default - a zero-length
array" (`clone`, `fill` and `default` at length 0). It fails before the fix
with the C error above and passes after. `tests/derive.test.yo`'s length-0
derive test covers the same path through a struct field.
