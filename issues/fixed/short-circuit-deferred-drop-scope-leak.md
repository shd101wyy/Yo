# Short-circuit || with RC temporaries: deferred drops leak to outer scope

**Status: FIXED**

## Problem

When chaining `||` expressions that produce RC-typed temporaries (e.g., `String`),
the short-circuit evaluation generates nested `if` blocks. The deferred drops for
temporaries created inside these inner `if` blocks are incorrectly emitted at the
outer function scope, where the variables are not declared.

## Reproduction

```rust
has_match :: (fn(content: String) -> bool)(
  (content.contains(`(c)`) || content.contains(`(C)`))
);
```

## Root cause

`generateDeferredDropExpressions()` in `src/codegen/exprs/drop-dup.ts` didn't check
`context.shortCircuitHandledDropVarNames` before emitting drops. The `and-or.ts`
codegen already correctly handled drops inside conditional branches and recorded
variable names in `shortCircuitHandledDropVarNames`, but `drop-dup.ts` re-emitted
those same drops at function scope where the variables weren't declared.

## Fix

Added the same `shortCircuitHandledDropVarNames` check that `begin.ts` already had
to `generateDeferredDropExpressions()` in `drop-dup.ts`.

## Regression test

Added "Short-circuit operators with RC temporaries" test in `tests/fn.test.yo`.
