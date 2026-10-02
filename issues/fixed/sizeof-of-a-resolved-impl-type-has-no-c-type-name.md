# `sizeof` of a resolved `Impl` type emits `sizeof(/* Error: no C type name … */)`

**Severity:** S2 — a valid program fails in the C compiler and `yo check` passes. `sizeof(IoFuture)` is enough.
**Found:** 2026-10-02, bisecting `issues/fixed/a-comptime-type-argument-holding-a-resolved-impl-never-specializes.md`. It reproduces on develop and on v0.2.48.

## Reproducer

```rust
{ println } :: import("std/fmt");
{ IoFuture } :: import("std/sys/future");
main :: (fn() -> unit)({
  a := sizeof(IoFuture);
  println(`${a}`);
});
export(main);
```

```
size_t a = sizeof(/* Error: no C type name for Impl(Future(i32)) */);
error: expected expression
```

## Cause

`IoFuture :: Impl(Concrete(__yo_io_future_t), Future(i32))` is a `SomeT` resolved to an extern opaque type. `get_size_of_type` has no compile-time size for it, so codegen emits a runtime `sizeof(<TypeVal>)`. The `TypeVal` arm of `generate_comptime_value` (`src/codegen/exprs/comptime_value.yo`) rendered every non-primitive type through the collected-type registry (`get_type_c_name`), which never holds a `SomeT`. `get_type_string` does know how to lower it: through its resolution, and for a heap-backed extern future to `__yo_io_future_t*`.

## Fix

The `TypeVal` arm lowers a `SomeT` through `get_type_string`, as it already did for primitives (`issues/fixed/sizeof-of-a-c-platform-type-has-no-c-type-name.md`). The regression test is "sizeof of a resolved Impl type is its lowered C type" in `tests/allocator.test.yo`. It covers the runtime `sizeof` and a `::` binding of it, fails on v0.2.48, and passes with the fix.
