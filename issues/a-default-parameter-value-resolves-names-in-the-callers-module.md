# A default parameter value resolves names in the caller's module

**Severity:** S1 — an omitted argument silently takes the value of a same-named binding in the CALLER's module instead of the declaring module's.

**Status:** OPEN. Found 2026-10-03 while checking the `box(v, alloc)` design in
`plans/VALUES_BY_DEFAULT.md` §3.2.

## Reproducer

```rust
// lib.yo
K :: i32(5);
f :: (fn((x : i32) ?= K) -> i32)(x);
export(f);
```

```rust
// main.yo
{ println } :: import("std/fmt");
{ f } :: import("./lib.yo");
K :: i32(99);
main :: (fn() -> unit)({
  println(`f() = ${f()}`);
});
export(main);
```

`yo compile main.yo -o a.out && ./a.out` prints `f() = 99`; the declaration
says 5. Delete main.yo's `K` and it prints 5. A default that names an import
of the declaring module (`(alloc : Allocator) ?= Allocator.global()` with
`Allocator` imported only in the library) fails at a caller without that
import: `error[E0401]: Variable "Allocator" not found`, pointing into the
library.

## Root cause

The evaluator records each default at definition time, both its value
(`get_func_param_defaults`) and its expression (`get_func_param_default_exprs`,
`src/evaluator/calls/helper.yo` Step 3). For an omitted argument, codegen emits
the default's EXPRESSION as the C argument (`runtime_arg_exprs_in_order`), and
it resolves that expression's names in the caller's environment. The
definition-time value, which is already resolved in the right module, is not
what reaches the C code.

## Fix direction

Defaults must be compile-time values (DESIGN §Default parameter values). So
emit the recorded definition-time `EvalValue` as a literal at the call site,
never re-resolve the expression. The companion issue
`issues/a-default-parameter-value-that-is-not-compile-time-known-emits-invalid-c.md`
makes the definition reject a default that has no compile-time value, so a
recorded value always exists.

## Test

`tests/` (with the fix): a two-module case where the caller binds the same
name as the default refers to (expects the declaring module's value), and a
default naming an import the caller does not have (expects it to compile and
use the declaring module's binding).
