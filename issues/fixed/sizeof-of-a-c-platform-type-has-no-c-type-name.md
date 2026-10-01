# `sizeof` of a C platform type emits `sizeof(/* Error: no C type name … */)`

**Severity:** S2 — a valid program fails in the C compiler, and `yo check` passes. A plain runtime `x := sizeof(int)` is enough.
**Found:** 2026-10-01, while fixing `issues/fixed/a-comptime-binding-with-an-unknown-value-emits-an-undeclared-identifier.md`. It reproduces on develop and on v0.2.47.

## Reproducer

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  x := sizeof(int);
  y := sizeof(long);
  println(`${x} ${y}`);
});
export(main);
```

```
size_t x = sizeof(/* Error: no C type name for int */);
error: expected expression
```

## Cause

The evaluator folds `sizeof` of a Yo scalar to a constant, but it leaves
`sizeof` of a C platform integer (`int`, `long`, …) as a typed runtime value,
since its width is target-dependent (`get_size_of_type` returns `.None`).
Codegen then emits `sizeof(<arg>)` and lowers the argument, a `TypeVal`,
through `generate_comptime_value`. That path asks only the collected-type
registry (`get_type_c_name`), and primitive scalars are never registered: their
C names are structural, and `get_type_string` produces them.

## Fix

The `TypeVal` arm of `generate_comptime_value`
(`src/codegen/exprs/comptime_value.yo`) now lowers a primitive, non-unit type
through `get_type_string`. Every other type still goes through the registry. The
regression test is "sizeof of a C platform type is a runtime value" in
`tests/allocator.test.yo`. It fails on v0.2.47 and passes with the fix.
