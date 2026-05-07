# Base Unspecialized Function Call for `using(exn)` Runtime Parameters

## Status

Worked around in `yo-self/evaluator/exprs/_expr.yo` (bootstrapping).
The underlying codegen issue is **not yet fixed** in the TypeScript compiler.

## Symptom

When a function `F` takes `using(exn : Exception)` and calls another function `G` that
also takes `using(exn : Exception)`, if the outer `exn` was received as a **runtime
parameter** (i.e. the caller explicitly passes a `void*` throw function pointer), the
codegen emits a call to the **base (unspecialized)** C function `fn_..._G`, which has no
definition. Only specialized versions of `G` exist (one per concrete `Exception` type at
call sites). The base version is never generated, causing:

```
call to undeclared function 'fn_yo70489165_id_9__evaluate_expression'
```

## Root Cause

Yo's codegen for `using(exn)` functions generates specialized C functions (one per
concrete throw function pointer). When a function receives `exn` as a runtime `void*`
and passes it to another `using(exn)` function, the codegen cannot select a specific
specialization and falls back to calling the base (unspecialized) function — but no
such base definition is generated.

This happens in `_evaluate_expression_raw_wrapper` which takes `using(exn : Exception)`
as a runtime parameter and then calls `_evaluate_expression(expr, env, ctx)` (implicitly
forwarding `exn`). The base `_evaluate_expression` has no C definition.

## Bootstrapping Workaround

Changed `_evaluate_expression_raw_wrapper` to call `_evaluate_expression_wrapper` (the
3-param panic-based version) instead of `_evaluate_expression`. This intentionally
ignores the caller's `exn` handler — exceptions always panic in Phase 2 bootstrapping.

```yo
// Before (broken):
_evaluate_expression_raw_wrapper :: (fn(..., using(exn : Exception)) -> AstExpr)(
  _evaluate_expression(expr, env, ctx)  // forwarded exn → base unspecialized call
);

// After (bootstrapping workaround):
_evaluate_expression_raw_wrapper :: (fn(..., using(exn : Exception)) -> AstExpr)(
  _evaluate_expression_wrapper(expr, env, ctx)  // ignores exn, always panics
);
```

## Proper Fix (Future)

The codegen should generate a base version of `using(exn)` functions that accepts a
`void*` throw function pointer and dispatches at runtime. This enables forwarding a
runtime `exn` without losing exception propagation.

## Files

- `yo-self/evaluator/exprs/_expr.yo` — workaround applied here
- `src/codegen/exprs/other-fn-call.ts` — where specialization dispatch happens
- `src/codegen/functions/generation.ts` — where base versions should be generated

## Impact

Exception propagation through `evaluate_expression_raw` is broken in the Phase 2
bootstrapped evaluator — exceptions panic instead of propagating to the caller.
This is an intentional Phase 2 limitation.
