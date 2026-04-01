# Match inside function argument generates phantom drop variable

## Status: RESOLVED

## Summary

When a `match` expression is used inline as an argument to a function call, the codegen generates a drop for a variable that doesn't exist, causing a C compilation error. This also affects `cond` expressions and nested `&&`/`||` short-circuit operators.

## Root Cause

Three separate issues contributing to phantom drops:

1. **Match/cond case body temp vars**: `evaluateBeginExpression` creates a temp variable in the parent begin block frame for each case body result. The match/cond then creates its own result variable, but the case body's temp var remains unconsumed and gets dropped at end of scope.

2. **Nested `&&`/`||` short-circuit**: `collectCreatedVarNamesFromExpr` recursively collected ALL temp var names from nested `&&`/`||` expressions. The outer `&&` would emit drops for vars only declared inside the inner conditional branch.

## Fix

1. Added `consumeCaseBodyTempVar()` helper in `match.ts` and `cond.ts` that marks case body temp variables as consumed after env pop, preventing phantom drops.

2. Modified `collectCreatedVarNamesFromExpr` in `and-or.ts` to stop recursing into conditional args of nested `&&`/`||` — those drops are handled by the inner operator's own `emitDropsForConditionalBranch`.

3. Added defense-in-depth in `mergeAndCheckEnvs` (expr.ts) to mark adopted temp vars as non-owning.
