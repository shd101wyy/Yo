# Enum Variant Shorthand Fails in `{ expr }` Function Bodies

## Status: Fixed

## Problem

Enum variant shorthand (e.g., `.Ok(42)`) fails with "Enum variant not selected for enum type" when used inside `{ expr }` function bodies without semicolons:

```rust
// FAILS: { .Ok(42) } parsed as anonymous struct, not begin block
get :: (fn() -> Result(i32, String))({ .Ok(i32(42)) });
```

The failure occurs at any nesting depth — single `.Ok(42)`, match inside `{ }`, or deeply nested match expressions.

## Root Cause

In `src/parser.ts`, `parseCurlyBracketExpr()` (lines 650-699) creates an anonymous struct `_( expr )` when the body has no semicolons. Only `{ expr; }` with semicolons creates a `begin()` block. When used as a function body, the anonymous struct `_(.Ok(42))` doesn't propagate `expectedType` for enum variant resolution, causing the shorthand to fail.

Key parsing rules:

- `{ expr }` (no separator) → anonymous struct `_( expr )`
- `{ expr; }` (semicolons) → begin block `begin( expr, () )`
- `{ expr1; expr2 }` → begin block `begin( expr1, expr2 )`

## Fix

In `src/evaluator/exprs/begin.ts`, at the start of `evaluateBeginExpression`, detect `_()` anonymous struct expressions with no labeled fields and convert them to `begin()` blocks. This ensures `expectedType` propagates to the last expression, enabling enum variant shorthand resolution.

The fix preserves actual struct values like `{ x: 1, y: 2 }` (which have labeled fields) while converting unlabeled single-expression cases like `{ .Ok(42) }` and `{ match(...) }` to begin blocks.

## Files Changed

- `src/evaluator/exprs/begin.ts` — Added `_()` to `begin()` conversion logic
