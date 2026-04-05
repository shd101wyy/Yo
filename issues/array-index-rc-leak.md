# Array Index Access Leaks RC Increment for Inline Use

**Status**: Fixed

## Problem

When accessing an array element of RC type (e.g., `Box(i32)`) inline without assigning
to a variable, the generated C code leaked a reference count increment.

```rust
x := Box(i32)(3);
y := [x,];
assert(y(0).* == 3, "leak");  // y(0).* generates incr_rc that is never decr_rc'd
```

Each `y(0).*` call incremented the RC but the duped pointer was embedded inline in the
expression and never stored in a droppable variable. The leaked increments prevented the
Box from being freed, causing a 24-byte leak detected by LeakSanitizer on Linux x86_64.

macOS ARM was unaffected because LeakSanitizer is not available there.

## Root Cause

Two issues collaborated to cause the leak:

1. **Codegen** (`src/codegen/exprs/generation.ts`): `generateIndexTraitCall` unconditionally
   called `generateDupCodeForValue` for output types containing RC, producing inline
   `__yo_incr_rc(...)` expressions. For assigned results (`tmp := y(0)`), this was balanced
   by `___drop(tmp)` at end of scope. For inline use (`y(0).*`), the duped pointer was
   never stored and never dropped.

2. **Evaluator** (`src/expr.ts`): `setExprAsNeedsToCallDup` returned early when
   `expr.$.value` was truthy (including `UnknownValue`), even for non-owning RC temp
   variables. This prevented the evaluator from generating proper dup/drop pairs for index
   results.

## Fix

1. **Evaluator** (`src/expr.ts:setExprAsNeedsToCallDup`): When the value is truthy but the
   temp variable is a non-owning RC type (like index trait results), fall through to generate
   a proper `___dup(temp)` call instead of returning early. This ensures dup is only generated
   when the result is consumed (assignment, function argument, return).

2. **Codegen** (`src/codegen/exprs/generation.ts:generateIndexTraitCall`): Removed the
   unconditional inline `generateDupCodeForValue` for RC output types. The evaluator now
   handles dup via `deferredDupExpressions` when needed. For inline use (`y(0).*`), no dup
   is generated since the value is immediately consumed and the container still owns it.

## Verification

- All 9 tests in `rc.test.yo` pass (including "Test Rc in different data structures")
- All test suites pass (530+ tests across all `.test.yo` files)
- Generated C confirmed: `tmp := y(0)` produces `___dup(temp)` via evaluator, inline
  `y(0).*` produces raw deref with no dup
