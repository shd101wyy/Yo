# Index trait: cannot index function call result (temporary)

## Description

The Index trait codegen does not handle indexing a temporary value returned by a function/method call. For example:

```rust
(ch : i32) = i32(buf.as_bytes()(usize(scan)));
```

Here, `buf.as_bytes()` returns `ArrayList(u8)` (a temporary), and `(usize(scan))` tries to index it via the Index trait. The codegen fails with:

```
Unhandled function call: (buf.as_bytes)()
```

The issue is that the Index trait desugars `value(idx)` into `Index.index(&value, idx).*`, which requires `&value` — taking a pointer to the receiver. Taking a pointer to a temporary (function call result) is not supported in C.

## Workaround

Extract the function call result into a named variable first:

```rust
(buf_bytes : ArrayList(u8)) = buf.as_bytes();
(ch : i32) = i32(buf_bytes(usize(scan)));
```

## Stack trace

```
at generateFuncCall (src/codegen/exprs/generation.ts:1073:15)
at _generateExpr (src/codegen/exprs/generation.ts:571:16)
at generateIndexTraitCall (src/codegen/exprs/generation.ts:167:22)
```

## Root Cause

Two issues in the evaluator's index trait call path (`src/evaluator/calls/function.ts`):

1. **Lost `runtimeArgExprsInOrder`**: When processing `get_list()(usize(1))`, the inner call `get_list()` is evaluated via `evaluateExpression`, which sets `runtimeArgExprsInOrder` on `func.$`. But the index trait path then overwrites `func.$` with a new object, losing `runtimeArgExprsInOrder`. Without it, the codegen's `generateOtherFunctionCall` can't generate the inner call.

2. **Lost temp variable for RC drop**: The inner call's evaluation adds a temp variable to `func.$.env` for RC drop tracking. But the `env` local variable in the outer scope wasn't updated, so `callerEnv` and subsequent operations didn't include the temp variable — causing a memory leak.

## Fix

- Propagate `func.$.env` back to the local `env` variable after evaluating the inner call (env update at line ~267)
- Preserve `runtimeArgExprsInOrder`, `deferredDropExpressions`, and `variableName` when overwriting `func.$` in the index trait path
- Added codegen safety net: `generateIndexTraitCall` emits a temp variable when the callee is a function call expression

## Status

Fixed.
