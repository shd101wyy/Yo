# Short-circuit evaluation fails for nested `&&`/`||` expressions

## Status: Fixed

## Problem

When `||` (with side-effectful sub-expressions like function calls) is the right operand of `&&`, the `||` expression is eagerly evaluated **before** the `&&` short-circuit check. This causes crashes when the left operand of `&&` is a bounds check that should prevent the right operand from executing.

Example:

```rust
while (((pos < max) && (isSpace(i32(bytes.get(usize(pos)).unwrap())) || (i32(bytes.get(usize(pos)).unwrap()) == i32(0x0A))))), {
  pos = (pos + i32(1));
};
```

When `pos >= max`, the `&&` should short-circuit and NOT evaluate the right side. But the right side (the `||` expression) was being fully evaluated, including the `.get(usize(pos)).unwrap()` calls, which panic on out-of-bounds access.

## Root Cause

In `src/codegen/exprs/and-or.ts`, the `exprMayHaveSideEffects` function only checked the top-level expression for a `variableName` property. It did **not** recursively check sub-expressions.

When the `||` expression itself has no `variableName`, but its sub-expressions (`.get()`, `.unwrap()`, `isSpace()`) do, `exprMayHaveSideEffects` incorrectly returns `false`. This causes `generateOpAnd` to use C's `&&` operator directly instead of the if-chain pattern, but the `||`'s side-effectful code has already been emitted by `generateOpOr`.

Generated C (buggy):

```c
// || code emitted eagerly — crashes when pos is out of bounds!
bool __yo_sc_260 = true;
fn_get(bytes, pos);         // out-of-bounds!
fn_unwrap(result);          // panics on .None!
bool isSpace_result = fn_isSpace(...);
if (!(isSpace_result)) {
  // second || operand...
}
// Too late — the damage is done:
result = ((pos < max) && __yo_sc_260);
```

## Fix

Made `exprMayHaveSideEffects` recursive — it now checks sub-expressions of function calls (including built-in operators like `op_or`, `op_and`). When any sub-expression has side effects, the parent expression is correctly classified as side-effectful, causing `generateOpAnd`/`generateOpOr` to use the if-chain pattern for proper short-circuit evaluation.

## Files Changed

- `src/codegen/exprs/and-or.ts` — `exprMayHaveSideEffects` now recursively checks sub-expressions
