# `&(K)` of a module-level `::` constant emits `/* skip generating value */`

**Severity:** S2 — a valid program fails at the C compiler with "expected expression"; binding the value with `:=` instead of `::` is the workaround
**Found:** 2026-09-29, implementing `plans/EXPLICIT_ALLOCATORS.md` P0 (an immortal pointer to a std allocator vtable).

## Reproducer

```rust
pragma(Pragma.AllowUnsafe);
{ assert } :: import("std/assert");
P :: struct(x : i32, y : i32);
_K :: P(x : i32(3), y : i32(4));
main :: (fn() -> unit)({
  p := &(_K);
  assert((p.*.x == i32(3)), "x");
});
export(main);
```

`yo check` passes. `yo compile` (v0.2.45) fails in the C compiler:

```
error: expected expression
  __yo_t_7692823147443975829* _file____home_temp_57565358042769440100 = /* skip generating value */;
```

## Cause

`evaluate_address_call` (`src/evaluator/builtins/ptr_fns.yo`) turns `&x` of any
variable with a non-empty value cell into a compile-time place
(`EvalValue.PtrVal(cell, 0)`). A module-level `::` binding always has one, so
`&(_K)` becomes a comptime pointer value, and codegen's comptime-value path
(`generate_comptime_value`, `src/codegen/exprs/comptime_value.yo`) has no
rendering for a pointer to a comptime place: it writes its placeholder.

This is the same shape as
`issues/fixed/address-of-a-parameter-in-a-generic-fn-emits-a-placeholder.md`,
for a different kind of variable. Falling through to the runtime address-of
emitter is not a fix on its own: `_K` has no C object, so the expression path
would take the address of a compound literal with automatic storage, which
dangles as soon as the pointer is returned from the function.

## Expected

A pointer to static storage holding the constant's value, the way Rust
promotes `&CONST` to a static: stable for the life of the program, so it can
be returned and stored.
