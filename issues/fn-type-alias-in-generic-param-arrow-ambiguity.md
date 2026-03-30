# Bug: Chained function call on `.unwrap()` result confuses evaluator with fn-type-containing generics

**Status: FIXED**

## Description

When a function has a parameter of type `*(ArrayList(FnType))` where `FnType` is a function type alias, and the body calls `.unwrap()(...args...)` in a chained manner (getting a value from the list and immediately calling it), the evaluator confuses the `-> ReturnType` of the outer function with the function type alias inside the generic parameter.

## Minimal Reproduction

```rust
{ ArrayList } :: import "std/collections/array_list";

MyStruct :: struct(x: i32);

BlockRuleFn :: (fn(state: *(MyStruct), a: i32, b: i32, c: bool) -> bool);
RuleList :: ArrayList(BlockRuleFn);

// FAILS: "Cannot unify: Expected 'BlockRuleFn', Given: 'bool'"
test :: (fn(state: *(MyStruct), a: i32, b: i32, c: bool, rules: *(RuleList)) -> bool)({
  return rules.*.get(usize(0)).unwrap()(state, a, b, c);
});
```

## Root cause

Two issues in `src/evaluator/calls/function.ts`:

1. **Evaluator**: When the callee of a function call is itself a function call (e.g., `.unwrap()` producing a callable), the outer call's `context.expectedType` (e.g., `bool`) leaked into the inner call's generic resolution. In `helper.ts`, early synthesis did `synthesizeTypes(T, bool)` → binding `T = bool` BEFORE parameter synthesis could correctly resolve `T = BlockRuleFn`.

   **Fix**: Clear `expectedType` when evaluating a callee that is a genuine function call (not a property access like `.Some`), preventing the outer return type from leaking into the inner call's type resolution.

2. **Codegen**: After evaluating the inner call, the code at line ~2055 overwrote `func.$` (the callee expression metadata), destroying `runtimeArgExprsInOrder` and `variableName` that were set during the inner call's evaluation.

   **Fix**: Preserve `runtimeArgExprsInOrder`, `deferredDropExpressions`, and (for function call callees) `variableName` when overwriting `func.$`.

## Regression test

Added "Chained unwrap call on Option of function type" test in `tests/fn.test.yo`.
