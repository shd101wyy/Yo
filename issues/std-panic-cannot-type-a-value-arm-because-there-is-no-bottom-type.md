# `std/assert`'s `panic` cannot be used in a value arm because Yo has no bottom type

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 3).
**Status:** OPEN. Completeness/design gap.
**Measured:** yo 0.2.39 seed.

## Repro

```rust
{ panic } :: import("std/assert");
f :: (fn(flag : bool) -> i64)({
  x := cond(flag => i32(3), true => panic("boom"));
  i64(x)
});
main :: (fn() -> unit)({ f(true); () });
export(main);
```

`error[E0601]: Incompatible types: Previous: i32, Current: unit`, whichever arm comes first; the
same in `match`.

## Mechanism (READ)

`TypeValue` has no `Never` variant. `std/assert.yo`'s `panic` is declared `-> unit`. Only the
`__yo_panic` builtin borrows a stand-in type (the expected type, else the fn result type,
`src/evaluator/builtins/panic.yo` ~67); `return(...)` and `unwind(...)` arms are special-cased.

## Fix direction

Add a bottom type (`never`) that is compatible with every expected type and is the join identity
for `cond`/`match` arms. Type `return`, `unwind`, `__yo_panic`, `std/assert.panic`,
`unreachable`-style helpers and `exit` as `never`. Codegen must then emit a `never`-typed call in
value position as a statement followed by a C value placeholder or `__builtin_unreachable()`
(not yet measured how each backend path handles this).
