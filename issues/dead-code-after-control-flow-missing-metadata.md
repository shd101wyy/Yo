# Dead Code After Control Flow Causes "return expression missing metadata"

## Status: Fixed

## Problem

When a `cond` or `match` expression where all branches contain `return` is followed by additional code in a begin block, the codegen crashes with:

```
Internal error: return expression missing metadata
```

Example:

```rust
get :: (fn(x: bool) -> Result(i32, String))({
  cond(
    x => { return .Ok(i32(42)); },
    true => { return .Err(`error`); }
  );
  return .Err(`unreachable`);  // Dead code — causes crash
});
```

## Root Cause

The evaluator's `evaluateBeginExpression` in `src/evaluator/exprs/begin.ts` correctly stops evaluating after a `cond`/`match` with control flow in all branches (line 921-924). The dead code after the cond (`return .Err("unreachable")`) is never evaluated and has no `$` metadata.

However, the codegen in `src/codegen/functions/generation.ts` iterates ALL `args` of the begin block (line 789). It has a `findReturn` check (line 792) that only detects explicit `return` expressions — not expressions like `cond` or `match` that propagate control flow. So the codegen attempts to generate code for the unevaluated dead code and crashes when `expr.$` is missing.

The same pattern exists in `src/codegen/exprs/cond.ts` and `src/codegen/exprs/match.ts` where begin block args inside branches are iterated.

## Fix

Added control flow checks after generating each expression in the begin block iteration:

- `src/codegen/functions/generation.ts` — Check `hasAnyControlFlow(arg.$?.controlFlow)` after each arg
- `src/codegen/exprs/cond.ts` — Same check in begin block handling inside cond branches
- `src/codegen/exprs/match.ts` — Same check in begin block handling inside match branches

When an expression with control flow is encountered, the loop breaks, skipping dead code that may lack evaluator metadata.

## Files Changed

- `src/codegen/functions/generation.ts` — Added dead code detection in function body codegen
- `src/codegen/exprs/cond.ts` — Added dead code detection in cond branch begin blocks
- `src/codegen/exprs/match.ts` — Added dead code detection in match branch begin blocks
