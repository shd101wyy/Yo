# `Var.is_owning_the_rc_value` / `Var.has_other_aliases` used as a value emit an empty C expression

**Severity:** S2 — a program that uses either answer at run time does not compile (the C compiler rejects `bool a = ;`)

**Status:** FIXED 2026-09-30 (`tss/impl-self-operator`).
**Found:** the stack's new `tests/iso.test.yo` case, which asserts the answers at run time.

## Measured

```rust
_VarProbe :: ref(struct(n : i32));
main :: (fn() -> unit)({
  p := _VarProbe(n : i32(1));
  a := Var.is_owning_the_rc_value(p);
  b := Var.has_other_aliases(p);
  println(`owning=${a} aliases=${b}`);
});
```

```
m.c:1999:12: error: expected expression
 1999 |   bool a = ;
```

The same on develop (2026-09-30, after #1022). The `^` isolation sugar, the builtins' only
user, reads them inside compile-time `cond` checks that fold away, so no emitted code ever
contained one.

## Root cause

`generate_expression` (`src/codegen/exprs/generation.yo`) grouped the two builtins with
`comptime_assert`, `requires`, `ensures` and `law`: the calls that are claims, erased at
codegen, returning `""`. Those have no value; these answer a question with a `bool`, which the
evaluator records as the call node's value.

## Fix

Codegen emits the recorded answer, `true` or `false`.

## Test

`tests/iso.test.yo`, "Var introspection answers about a variable and rejects anything else",
asserts both answers at run time.
