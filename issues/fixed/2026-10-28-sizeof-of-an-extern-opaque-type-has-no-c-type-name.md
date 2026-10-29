# `size_of` of an extern opaque type emits `sizeof(/* Error: no C type name … */)`

**Severity:** S2 (a valid program fails in the C compiler while `yo check`
passes; `size_of(atomic_int)` is enough)

**Status:** fixed 2026-10-28 (branch `vbd/alloc-v2-gen-b-r2`, allocator
interface v2 Generation B).
**Found:** 2026-10-28, by the test of
`issues/fixed/2026-10-28-align-of-a-type-holding-an-extern-type-never-transpiles.md`,
which compares `align_of(atomic_int)` with `size_of(atomic_int)`. It
reproduces with a develop-built binary (`ef59d9dd8`).

## Reproducer

```yo
{ assert } :: import("std/assert");
{ atomic_int } :: import("std/libc/stdatomic");
main :: (fn() -> unit)({
  n := size_of(atomic_int);
  assert(n >= usize(1), "atomic_int has a size");
});
export(main);
```

```text
size_t __yo_v_n = sizeof(/* Error: no C type name for atomic_int */);
error: expected expression
```

## Cause

An extern opaque type (`extern("Yo", X : Type)`, or a type a `c_include`
binds, such as `atomic_int` or `FILE`) is an `ExternOpaqueT` whose layout only
the C compiler knows, so the evaluator leaves `size_of` of it a typed runtime
value and codegen emits `sizeof(<arg>)`. The argument, a `TypeVal`, lowers
through `generate_comptime_value`, which asks the collected-type registry for
every type that is not a primitive scalar or a `SomeT`
(`issues/fixed/sizeof-of-a-c-platform-type-has-no-c-type-name.md`,
`issues/fixed/sizeof-of-a-resolved-impl-type-has-no-c-type-name.md`). An
extern opaque type is never registered: its C name is its C spelling. A struct
holding one is registered, so `size_of` of the struct worked.

## Fix

The `TypeVal` arm of `generate_comptime_value`
(`src/codegen/exprs/comptime_value.yo`) lowers an `ExternOpaqueT` through
`get_type_string`, which returns its C spelling.

## Test

`tests/allocator.test.yo`, "size_of and align_of of an extern C type, and
align_of of a struct holding one, are the C compiler's", asserts
`align_of(atomic_int) == size_of(atomic_int)`; the batch fails to compile
before the fix.
