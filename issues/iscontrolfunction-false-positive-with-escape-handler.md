# Followup: investigate `isControlFunction` false-positive on async fns with escape-handlers

## Status: RESOLVED

**Root cause** identified and fixed in `src/expr-traversal.ts`. The workaround in `src/codegen/functions/collection.ts` (commit `53bece33`) has been reverted.

### Root cause

Handler-lambda arrows used as values of module fields (e.g., `Exception(throw : ((err) -> {...}))`) do NOT go through `evaluateAnonymousFunctionImplementation` when evaluated as arguments to a module constructor. They are evaluated via the module-field path in `src/evaluator/calls/function.ts` which sets `expr.$ = { env, type, value, pathCollection }` — all the keys of an anonymous function, **except** `isAnonymousFunctionDefinition: true`.

As a result, `isFunctionBoundaryArrow` in `src/expr-traversal.ts` (case 1 — which checks `$.isAnonymousFunctionDefinition === true`) returned `false` for these handler arrows. Case 3 (`!expr.$`) also didn't apply because the handler arrow DID have `$`. So traversal recursed into the handler body and found the inner `escape`, marking the enclosing async fn as `isControlFunction=true`.

### The fix

Add Case 1b to `isFunctionBoundaryArrow`: any arrow whose `$.value` is a `FunctionValue` is a function boundary. This correctly identifies arrows evaluated via non-anonymous-fn paths that produced a runtime function value.

```ts
if (expr.$?.value !== undefined && isFunctionValue(expr.$.value)) return true;
```

### Why it manifested only with `io.await`

Without `io.await`, the SM transformation isn't needed and the call-site path `generateAsync`/`generateEscape` uses inline SM dispatch; the false `isControlFunction=true` produced a body-inlining plan that happened to succeed (since no call-site needed a named C function).

With `io.await`, the async-SM specialization produced a real `FunctionValue` registered as `ctl` (inline-only). Call sites tried to dispatch via named C function, found nothing registered, and emitted `Unhandled function call`.

## Regression tests

`tests/control_fn_as_regular_call.test.yo` — 3 tests that verified failure before the fix and now pass cleanly without the workaround.

## Related notes

Many places in the evaluator set `expr.$` for arrows/calls without propagating `isAnonymousFunctionDefinition`. Rather than try to fix them all, `isFunctionBoundaryArrow` now uses the more robust check "`$.value is FunctionValue`" which captures any arrow that has evaluated to a runtime function, regardless of which evaluation path produced it.
