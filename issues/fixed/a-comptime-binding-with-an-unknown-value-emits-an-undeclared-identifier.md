# A `::` binding with an unknown compile-time value emits an undeclared identifier

**Severity:** S2 — a valid program fails in the C compiler, and `yo check` passes. `x :: sizeof(int)` followed by a read of `x` is enough.
**Found:** 2026-10-01, alongside `issues/fixed/sizeof-of-a-dyn-type-is-not-a-compile-time-constant.md`. It reproduces on develop and on v0.2.47.

## Reproducer

```rust
main :: (fn() -> unit)({
  a :: sizeof(int);
  println(a);
});
```

```
error: use of undeclared identifier 'a'
```

`size_would_overflow(int, n)` fails the same way, on its `type_size :: sizeof(T)`.

## Cause

A local `::` binding emits no C. Codegen's `::` arm returned `""`, and every read
inlines the constant (`generate_atom`). But the evaluator can know a binding's
TYPE without its VALUE. `sizeof(int)` is target-dependent: `get_size_of_type`
answers `.None` for the C platform integers, and `sizeof` then returns a typed
unknown. For such a binding `generate_atom` falls back to the binding's C name,
which nothing declared.

## Fix

The `::` arm (`_generate_comptime_binding`, `src/codegen/exprs/generation.yo`)
declares the binding as `const <C type> <name> = <initializer>;` when its value is
a typed unknown of a scalar or pointer type, which is what reads then reference. A
binding with a known value still emits nothing. The regression test is "a comptime
binding with a target-dependent value is still readable" in
`tests/allocator.test.yo`. It fails on v0.2.47 and passes with the fix.
