# `sizeof` of a dyn type is not a compile-time constant

**Severity:** S2 — a valid program fails in the C compiler, and `yo check` passes. `ArrayList(Dyn(Error)).with_capacity(n)` is enough to trigger it.
**Found:** 2026-10-01. The v0.2.47 seed failed to build the compiler once `plans/archive/EXPLICIT_ALLOCATORS.md` P3c routed every `ArrayList.new()` through `with_capacity_in`. That instantiated `size_would_overflow(Dyn(Error), n)` for the compiler's own `Dyn(Error)` lists. The bug reproduces on develop and on v0.2.47.

## Reproducer

```rust
{ size_would_overflow } :: import("std/allocator");
{ Error } :: import("std/error");
main :: (fn() -> unit)({
  println(size_would_overflow(Dyn(Error), usize(4)));
});
```

```
error: use of undeclared identifier 'type_size'
```

`size_would_overflow(i32, n)` compiles. So does `x :: sizeof(Dyn(ToString))` read back, which emitted `use of undeclared identifier 'x'`.

## Cause

`get_size_of_type` (`src/types/utils.yo`) had no arm for `DynT`, so the size fell
through to "unknown". `sizeof` then returned a typed unknown `usize`. It does
that on purpose, so that `sizeof(T)` works in a generic body at definition time.
The `type_size :: sizeof(T)` binding therefore had no value to inline. A `::`
binding emits no C, so the read became a bare, undeclared name. The second half
is filed separately as
`issues/fixed/a-comptime-binding-with-an-unknown-value-emits-an-undeclared-identifier.md`.

A `Dyn(...)` is always the same fat pointer, `{ void* data; const vtable* vtable; }`,
whatever its traits (`generate_dyn_box_types` / the dyn declaration in
`src/codegen/types/generation.yo`).

## Fix

`get_size_of_type` answers 2 × pointer size for `DynT`, and
`get_alignment_of_type` answers pointer alignment. The regression test is "sizeof
of a dyn type is a compile-time fat pointer" in `tests/allocator.test.yo`. It fails
on v0.2.47 and passes with the fix.

P3c (#1034) cannot land until a seed carries this fix: the seed's own codegen
builds the stage-1 compiler, and P3c's containers instantiate the failing
specialization.
