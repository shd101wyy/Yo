# Where Clause Constraint Scoping Migration
> **ARCHIVED 2026-09-04 — IMPLEMENTED.** Where-clause constraints are
> function-scoped; they no longer leak between sibling functions.


## Overview

This document describes the migration from globally-mutating where clause constraints to function-scoped where clause constraints. The change prevents where clause constraints from leaking between sibling functions.

## Problem Statement

### Original Issue

Before this migration, where clause constraints were implemented by directly mutating the `SomeType`'s module fields. This caused constraints to leak across function boundaries:

```rust
LinkedList :: (fn(comptime(T): Type) -> comptime(Type))(
  object(
    // This function has where(T <: Eq(T))
    has :: (fn(
      self: Self,
      value: T,
      where(T <: Eq(T))
    ) -> bool)({
      current_opt.value == value;  // Works - T has Eq(T)
    }),

    // This function has NO where clause
    test_without_where :: (fn(self : Self, value : T) -> bool)({
      current_opt.value == value;  // SHOULD FAIL but didn't!
    })
  )
);
```

**Root Cause**: When evaluating `has`'s where clause, the constraint `T <: Eq(T)` was added to the shared `T` SomeType's module fields. This mutation persisted, so `test_without_where` could also see `Eq(T)` on `T`, even though it didn't declare this constraint.

### Expected Behavior

- Functions with `where(T <: Eq(T))` should be able to use `==` on `T`
- Functions without the where clause should fail with a type error when trying to use `==` on `T`
- Where clause constraints should be scoped to the declaring function only

## Solution Design

### Architecture

The solution introduces function-scoped constraint storage:

1. **FunctionType Enhancement**: Add `whereClauseConstraints` map to store constraints per SomeType
2. **Context Threading**: Add `currentFunctionType` to evaluation context
3. **Dual-Mode Constraint Storage**:
   - Functions: Store constraints in `FunctionType.whereClauseConstraints`
   - Modules: Keep existing behavior (mutate SomeType for collection)
4. **Method Lookup Enhancement**: Check function-scoped constraints when resolving methods

### Key Data Structures

```typescript
// FunctionType now has:
interface FunctionType {
  whereClauseConstraints?: Map<
    SomeType,
    {
      requiredModules: ModuleType[];
      negativeModules: ModuleType[];
    }
  >;
}

// EvaluatorContext now has:
interface EvaluatorContext {
  currentFunctionType?: FunctionType;
}
```

## Implementation

### Phase 1: Type System Changes

**File**: `src/types/definitions.ts`

Added `whereClauseConstraints` field to `FunctionType`:

```typescript
export interface FunctionType extends Type {
  // ... existing fields ...

  /**
   * Where clause constraints for this function.
   * Maps each SomeType to its required and negative module constraints.
   */
  whereClauseConstraints?: Map<
    SomeType,
    {
      requiredModules: ModuleType[];
      negativeModules: ModuleType[];
    }
  >;
}
```

### Phase 2: Context Enhancement

**File**: `src/evaluator/context.ts`

Added `currentFunctionType` field to track which function's constraints to populate:

```typescript
export interface EvaluatorContext {
  // ... existing fields ...

  /**
   * The function type being evaluated, used to store where clause constraints.
   * Set when evaluating function type parameters.
   */
  currentFunctionType?: FunctionType;
}
```

### Phase 3: Constraint Storage Logic

**File**: `src/evaluator/exprs/subtype_of.ts`

Rewrote where clause handling to distinguish between function and module contexts:

```typescript
if (context.isInsideWhereClause && isSomeType(typeValue.value)) {
  const someType = typeValue.value;
  const functionType = context.currentFunctionType;

  if (functionType) {
    // Function where clause: store in function's map (NEW BEHAVIOR)
    if (!functionType.whereClauseConstraints) {
      functionType.whereClauseConstraints = new Map();
    }
    // ... populate map ...
  } else {
    // Module where clause: mutate SomeType (OLD BEHAVIOR PRESERVED)
    someType.module.fields.push({
      tag: "constraint",
      type: moduleWithReceiver,
    });
  }
}
```

**Key Decision**: We preserve the old mutating behavior for module where clauses because modules collect constraints differently and don't have the same scoping issues.

### Phase 4: Placeholder Function Type Pattern

**File**: `src/evaluator/types/function.ts`

Created placeholder function type before parameter evaluation:

```typescript
// Create placeholder function type to collect where clause constraints
const placeholderFunctionType: FunctionType = {
  tag: TypeTag.Function,
  paramTypes: [],
  returnType: createVoidType(),
  module: undefined,
  env,
};

// Pass placeholder in context during parameter evaluation
const evaluatedParams = evaluateFunctionParameters({
  // ...
  context: {
    ...context,
    currentFunctionType: placeholderFunctionType,
  },
});

// Transfer constraints to final function type
if (placeholderFunctionType.whereClauseConstraints) {
  functionType.whereClauseConstraints =
    placeholderFunctionType.whereClauseConstraints;
}
```

**Rationale**: Where clauses are evaluated during parameter parsing, but we need the final function type structure. The placeholder collects constraints which are then transferred to the real function type.

### Phase 5: Method Lookup Enhancement

**File**: `src/env.ts`

Enhanced `getMethodsByNameFromEnv` to check function-scoped constraints:

```typescript
export function getMethodsByNameFromEnv(
  env: Environment,
  methodName: string,
  receiverType: Type,
  isInfixOperatorCall: boolean,
  currentFunctionType?: FunctionType // NEW PARAMETER
): MethodLookupResult[] {
  // ... existing logic ...

  if (isSomeType(dereferencedReceiverType)) {
    // Check base requiredModules from SomeType
    const baseModules = dereferencedReceiverType.requiredModules || [];

    // Check function-scoped where clause constraints (NEW)
    const whereConstraints = currentFunctionType?.whereClauseConstraints?.get(
      dereferencedReceiverType
    );

    const allRequiredModules = [
      ...baseModules,
      ...(whereConstraints?.requiredModules || []),
    ];

    // ... rest of method lookup logic ...
  }
}
```

### Phase 6: Integration

**File**: `src/evaluator/calls/function.ts`

Updated call sites to pass current function type:

```typescript
const methods = getMethodsByNameFromEnv(
  env,
  methodName,
  receiverType,
  isInfixOperatorCall,
  // Extract function type from context
  context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body"
    ? context.isEvaluatingFunctionBodyOrAsyncBlock.type
    : undefined
);
```

## Breaking Changes

### None Expected

This change is **non-breaking** for correctly written code:

- Functions that properly declare where clause constraints continue to work
- Functions without where clauses now correctly fail (this was a bug before)
- Module where clauses continue to use the same behavior

### Edge Cases

**Incorrect code that may have worked before**:

```rust
Container :: (fn(comptime(T): Type) -> comptime(Type))(
  object(
    method1 :: (fn(self: Self, where(T <: Copy)) -> unit)({ ... }),

    // This relied on leaked constraints - now fails correctly
    method2 :: (fn(self: Self) -> unit)({
      // Tries to use Copy methods on T without declaring where clause
    })
  )
);
```

**Migration**: Add the where clause to `method2` if it needs `T <: Copy`.

## Testing

### Test Case

The fix is validated by `src/tests/examples/fixme.yo`:

```rust
LinkedList :: (fn(comptime(T): Type) -> comptime(Type))(
  object(
    has :: (fn(
      self: Self,
      value: T,
      where(T <: Eq(T))  // Declares constraint
    ) -> bool)({
      current_opt.value == value;  // ✓ Works
    }),

    test_without_where :: (fn(self : Self, value : T) -> bool)({
      current_opt.value == value;  // ✗ Should fail - NO Eq(T)
    })
  )
);
```

**Expected Result**: `test_without_where` should fail with a type error when trying to use `==` because `T` doesn't have `Eq(T)` in that function's scope.

### Running Tests

```bash
bun test src/tests/fixme.test.ts
```

## Implementation Status

### Completed ✅

- [x] Add `whereClauseConstraints` to `FunctionType`
- [x] Add `currentFunctionType` to `EvaluatorContext`
- [x] Update where clause evaluation logic in `subtype_of.ts`
- [x] Implement placeholder function type pattern
- [x] Enhance `getMethodsByNameFromEnv` to check function constraints
- [x] Update function call sites to pass current function type
- [x] Verify test passes

### Pending 🔄

- [ ] Update VSCode extension call site (`vscode-extension/src/extension.ts:1138`)
  - Non-critical: Just needs optional parameter added
  - Can be done independently

## Design Rationale

### Why Not Remove Constraints After Function?

**Rejected Approach**: Use a stack-based system with `frameLevel` tracking and pop constraints after function evaluation.

**Problem**: Where clause constraints must be available during:

1. Function type evaluation (for parameter type checking)
2. Function body evaluation (for method resolution)

Popping constraints after type evaluation would break body evaluation.

### Why Not Create New SomeTypes?

**Rejected Approach**: Create a new copy of the SomeType with constraints for each function.

**Problem**: Too complex - would require updating all type references throughout the codebase. Type identity and equality checks would break.

### Why Function-Scoped Storage?

**Chosen Approach**: Store constraints in `FunctionType.whereClauseConstraints` map.

**Benefits**:

- No mutation of shared SomeTypes
- Proper scoping (constraints only visible within declaring function)
- Constraints available during both type checking and body evaluation
- Minimal code changes
- Clear ownership model

### Why Preserve Module Behavior?

Module where clauses still mutate SomeTypes because:

1. Modules collect constraints differently (into `selfConstraints` arrays)
2. Modules don't have the same scoping/leaking issues
3. Module constraint collection happens in a single pass
4. Changing module behavior requires larger refactoring

## Future Work

### Potential Improvements

1. **Unify Constraint Storage**: Consider storing module where clause constraints similarly to avoid any mutation
2. **Constraint Validation**: Add explicit validation that function where clauses are properly scoped
3. **Better Error Messages**: Enhance error messages to suggest adding where clauses when missing
4. **Performance**: Consider caching constraint lookups if they become a bottleneck

### Related Features

- **Trait bounds**: Similar constraint system could be used for trait bounds
- **Higher-kinded types**: Where clause mechanism could extend to higher-kinded constraints
- **Specialization**: Constraints could inform type specialization decisions

## References

### Key Files

- `/home/deck/Workspace/Yo/src/types/definitions.ts` - Type definitions
- `/home/deck/Workspace/Yo/src/evaluator/context.ts` - Evaluation context
- `/home/deck/Workspace/Yo/src/evaluator/exprs/subtype_of.ts` - Where clause evaluation
- `/home/deck/Workspace/Yo/src/evaluator/types/function.ts` - Function type evaluation
- `/home/deck/Workspace/Yo/src/env.ts` - Method lookup
- `/home/deck/Workspace/Yo/src/evaluator/calls/function.ts` - Function call evaluation

### Related Documentation

- `LEARN_YO_IN_10_MINUTES.yo` - Yo language syntax guide
- `DESIGN.md` - Overall language design (may be outdated)

## Conclusion

This migration fixes a critical scoping bug in where clause constraints while maintaining backward compatibility. The implementation uses function-scoped storage to ensure constraints don't leak between functions, providing proper type safety without requiring breaking changes to existing code.
