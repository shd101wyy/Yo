# quote/unquote validation fails with non-Expr type UnknownValues

## Problem

When a function body contains `quote(... #(param) ...)` where `param` has type `ComptimeList(Expr)`
(not `Expr`), the function body validation fails with:

```
Error: Expected expression type for "unquote" argument, got: param
```

This happens because `processUnquotesInExpr` in `quote.ts` evaluates `unquote` arguments
during function body validation. Parameters with `comptime` types become `UnknownValue`
during validation. The check at line 55-63 required `isExprType(evaluatedArg.$.type)` to
be true, but `ComptimeList(Expr)` is not `Expr` type.

## Root cause

During function body validation (`isValidatingFunctionDefinition: true`), comptime parameters
have `UnknownValue` with their declared types. The `processUnquotesInExpr` function tried to
validate `unquote` and `unquote_splicing` arguments strictly, throwing when the type didn't
match `Expr` or `ExprList` exactly.

## Fix

In `quote.ts`, modified both `unquote` and `unquote_splicing` handlers to tolerate
non-matching types when the value is `UnknownValue` — return the original expression unchanged
instead of throwing. The actual type checking happens at call time when real values are bound.

## Related issue

`...#(x)` is parsed as `...(#(x))` (two nested calls: spread → unquote) rather than
`unquote_splicing(x)` (single call). Added `isSpreadUnquote` pattern matching in the
`unquote_splicing` handler to recognize this alternate parse form.

## Files changed

- `src/evaluator/builtins/quote.ts`
