# Generic instance-method with explicit `return(...)` body fails to specialize

**Status:** FIXED (yo-self/evaluator/calls/helper.yo, `create_specialized_function_inline`).

## Symptom

A call to a generic instance method whose body uses an explicit `return(...)`
statement (e.g. std `ArrayList(u8).len()`, whose body is `return(self._length)`)
produced no `ExprInfo` at the call site, so codegen emitted
`// Failed to transpile n := (al.len)();`. The motivating user-level program:

```rust
{ ArrayList } :: import("std/collections/array_list");
main :: (fn() -> unit)({
  al := ArrayList(u8).new();
  n := al.len();          // <- "Failed to transpile"
  unsafe(putchar(int(i32(usize(48) + n))));
});
```

The TS reference compiled and ran this correctly (prints `0`); the self-hosted
compiler did not.

## Minimal reproducer

`tests/codegen-bootstrap/generic_impl_method_return_body.yo` — a custom generic
`object` type with a `?*(T)` field (forces a runtime value) and an instance
method `glen : (fn(self : Self) -> usize)({ return(self._len); })`. The bug
appears **only** with the explicit-`return` body; a bare-expression body
(`self._len`) worked, which is what isolated the root cause.

## Root cause

`create_specialized_function_inline` re-evaluates the method body via
`evaluate_begin_expression` to monomorphize it, but did **not** set
`ctx.is_evaluating_function_body_or_async_block`. `begin.yo` gates `return` on
that field and throws *"The 'return' keyword can only be used inside a function
body or async block."* otherwise. The throw propagated out of `try_to_call...`
→ the method-call arm never reached its `expr_info_table_set`, so the call site
had no `ExprInfo` → "Failed to transpile". Bare-expression bodies contain no
`return`, so they never tripped the gate.

This was an unfaithful port: TS `helper.ts:2434-2462` evaluates the specialized
body under `{ ...context, isEvaluatingFunctionBodyOrAsyncBlock: {...}, ... }`.

## Fix

Set the full TS override set around the body eval (saved/restored):

- `is_evaluating_function_body_or_async_block` = `FunctionBody` with a func_type
  carrying the **specialized** return type (so a generic `-> T` / `-> Self`
  return arg is checked against the concrete type),
- `captured_variables` = `None` (TS `capturedVariables: undefined`) — without
  this, a nested regular `->` function in the body inherited the caller's
  capture map and wrongly reported *"a regular function cannot capture outer
  runtime variables"* (this is what broke `std/path.yo`),
- `is_evaluating_loop_body` = `None`,
- `expected_type` = the specialized return type,
- `function_return_impl_concrete_type` = fresh array.

## Validation

- `tests/codegen-bootstrap`: 39/39 PASS, 0 DIFF (added
  `generic_impl_method_return_body` + `std_arraylist_len`).
- std per-file `check` sweep (`-O0`): base 93/59 → fixed 94/58 — `std/path.yo`
  recovered, **zero** regressions (fixed's failing set ⊂ base's failing set).
- `std/collections/array_list.yo`, `std/path.yo` check clean.
