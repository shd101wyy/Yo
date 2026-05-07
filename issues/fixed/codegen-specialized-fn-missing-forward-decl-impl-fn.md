# Codegen: Specialized function missing forward declaration for `Impl(Fn(...))` params

**Status**: Fixed  
**Component**: `src/codegen/functions/declarations.ts` — `generateSpecializedFunctionDeclarations`

## Description

In batch compilation (e.g. test files that import modules), a specialized function with an `Impl(Fn(...))` parameter failed to get a forward declaration, causing "call to undeclared function" errors when a caller function was emitted before the callee.

Example from `yo-self/evaluator/shared/suspension_analysis.yo`:

```rust
walk_expr_ := fn(e : AstExpr, get_info : Impl(Fn(AstExpr) -> Option(ExprInfo)), ...) -> () { ... };
```

In batch compilation, the specialization discovery order could place `analyze_suspension_points` (caller) before `walk_expr_` (callee) in the output, with no forward declaration for `walk_expr_`.

## Root Cause

`generateSpecializedFunctionDeclarations` used `isFunctionTypeHardGeneric(specializedFunctionType)` to decide whether to emit a forward declaration. This function does **not** exclude `Impl(Fn(...))` SomeTypes, so it returned `true` for `walk_expr_` and the forward declaration was skipped.

But `generateSpecializedFunctions` uses `isUnresolvedSomeType` which explicitly excludes Fn SomeTypes (via `typeImplementsFn`), so the function **body** was still generated — but without a forward declaration, C saw the call before the definition.

The inconsistency:

- `typeContainsSomeType` (used in body generation): excludes `Impl(Fn(...))` → treats as concrete
- `isFunctionTypeHardGeneric` (used in declaration): does NOT exclude `Impl(Fn(...))` → treats as still-generic

## Fix

Replaced the `isFunctionTypeHardGeneric` check in `generateSpecializedFunctionDeclarations` with the same `isUnresolvedSomeType` logic used by `generateSpecializedFunctions`:

```typescript
const isUnresolvedSomeTypeForDecl = (t: Type): boolean => {
  if (!isSomeType(t)) return false;
  if ((t as SomeType).resolvedConcreteType) return false;
  if (typeImplementsFuture(t)) return false;
  if (typeImplementsFn(t)) return false;
  return true;
};
const hasForallOrCompileTimeSpecDecl =
  specializedFunctionType.forallParameters.length > 0 ||
  specializedFunctionType.parameters.some((p) => p.isCompileTimeOnly);
const hasSomeTypeParamsSpecDecl = specializedFunctionType.parameters.some(
  (p) => !p.isCompileTimeOnly && isUnresolvedSomeTypeForDecl(p.type)
);
if (hasForallOrCompileTimeSpecDecl || hasSomeTypeParamsSpecDecl) {
  continue;
}
```

Added imports: `typeImplementsFn` from `../../evaluator/trait-checking`, `SomeType` and `Type` from `../../types/definitions`.

**File changed**: `src/codegen/functions/declarations.ts`

## How to Reproduce (before fix)

Batch-compile any test file that imports `suspension_analysis.yo` (e.g., `yo-self/tests/suspension_analysis.test.yo`). The generated C would have `walk_expr_id_N` called from `analyze_suspension_points_id_N` without a prior forward declaration. In standalone compile, the definition order happened to be correct by chance (lexical order), so no error appeared.

## Test Coverage

`yo-self/tests/suspension_analysis.test.yo` — all 9 tests now pass.
