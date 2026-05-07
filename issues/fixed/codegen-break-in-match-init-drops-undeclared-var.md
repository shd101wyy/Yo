# Codegen: `break` inside match-init drops not-yet-declared variable

**Status**: Fixed  
**Component**: `src/codegen/exprs/atom.ts` — `emitLoopBodyDropsBeforeExit`

## Description

When a while-loop body contains:

```rust
while runtime(cond), {
  x := match(some_expr,
    .None => { break; },
    .Some(v) => v
  );
  use(x);
};
```

The C compilation failed with `use of undeclared identifier 'x'` because the `break` path tried to drop `x` before it was declared in C.

## Root Cause

`emitLoopBodyDropsBeforeExit` (called when `break` fires) uses a **position-based filter** to skip drops for not-yet-declared variables. The filter compares `initializedAtToken.position.character` (the absolute character offset of the `:=` token) against the `break` token's character offset.

For `x := match(...)`:

- `x`'s `initializedAtToken` is set to the `:=` token on the line **before** the `break`
- In source order: `:=` (line N) < `break` (line N+1) → filter says "x is initialized, emit drop"
- But in generated C: `x`'s declaration is emitted **after** the entire `switch` statement, so the `break`'s `goto loop_...` fires before `x` exists

The `return` code path (`generatePendingDeferredDrops` in `return.ts`) does this correctly: it filters by the **return expression's env** — if the variable isn't in the env at the return point, it's skipped. A variable not yet initialized won't be in the env.

## Fix

Changed `emitLoopBodyDropsBeforeExit` to use **env-based** liveness checking (matching `generatePendingDeferredDrops`) when the break/continue expression's env is available:

1. If `expr.$?.env` is present: look up the variable in that env. If absent → skip. If present but `!initializedAtToken` → skip.
2. Otherwise: fall back to the original position-based filter.

**File changed**: `src/codegen/exprs/atom.ts`

## How to Reproduce (before fix)

The pattern appears in `yo-self/evaluator/shared/suspension_analysis.yo` at lines 517–528 and 545–555 (`analyze_suspension_points` function), and triggered when batch-compiling with the test file.

Standalone compile succeeded because the equivalent match in `walk_expr_` (line 461) uses `return` instead of `break`, which went through the correctly-guarded `generatePendingDeferredDrops` path.

## Test Coverage

`yo-self/tests/suspension_analysis.test.yo` — all 9 tests now pass.
