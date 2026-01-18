# Migration Plan: Structural to Nominal ModuleType

## Overview

This document outlines the plan to migrate Yo's `ModuleType` from structural typing to nominal typing, along with implementing duplicate impl detection and orphan rules.

## Current State

### Structural Module Type

Currently, `ModuleType` is a **structural type** (as stated in `definitions.ts` line 392):

```typescript
/**
 * ModuleType is a structural type that represents a module. It's not a nominal type like Struct/Enum/Union.
 */
export interface ModuleType extends Type {
  // ...
}
```

In `areTypesCompatible`, modules are compared structurally by checking:

1. If both types are modules
2. FnModule/FutureModule special cases
3. Field-by-field comparison (label, type, assignedValue)

### Problems with Structural Typing

1. **Identity confusion**: Two modules with the same fields are considered the same, even if they have different semantic meanings.
2. **No duplicate impl detection**: Nothing prevents implementing the same module multiple times for the same type.
3. **No orphan rule protection**: Any code can implement any module for any type.

## Target State

### Nominal Module Type

Modules should be identified by their **unique id**, not by their structure. Two modules with identical fields but different ids should be considered different types.

### Orphan Rule

Following Rust's coherence rules:

- A module implementation is only allowed if:
  1. The module is defined in the current crate/package, OR
  2. The target type is defined in the current crate/package

This prevents conflicting implementations from different packages.

### Duplicate Impl Detection

- When implementing a module for a type, check if the module is already implemented
- Throw an error if attempting to implement the same module twice for the same type

---

## Migration Steps

### Phase 1: Add Module Identity Infrastructure

#### 1.1 Update `ModuleType` interface (definitions.ts)

Add fields for tracking module origin and identity:

```typescript
export interface ModuleType extends Type {
  // ... existing fields ...

  /**
   * The module path where this module was defined.
   * Used for orphan rule checks.
   */
  definedInModulePath?: string;
}
```

#### 1.2 Update module creation to set `definedInModulePath`

In `evaluateModuleTypeExpr` (or wherever modules are created), set the `definedInModulePath` from context.

Files to modify:

- `src/evaluator/types/module.ts` - Set definedInModulePath when creating ModuleType

### Phase 2: Update Type Compatibility (areTypesCompatible)

#### 2.1 Change ModuleType comparison from structural to nominal

In `src/types/compatibility.ts`, update the `isModuleType(expected.type)` branch:

**Current behavior (structural)**:

```typescript
if (isModuleType(expected.type)) {
  // ... structural comparison of fields ...
  for (let i = 0; i < expected.type.fields.length; i++) {
    // Compare labels, types, assignedValues
  }
  return true;
}
```

**New behavior (nominal)**:

```typescript
if (isModuleType(expected.type) && isModuleType(given.type)) {
  // Primary check: same module id = same module
  if (expected.type.id === given.type.id) {
    return true;
  }

  // Special case: FnTraitType and FutureTraitType use structural comparison
  // because they are parameterized (Fn(x: i32) -> i32 vs Fn(y: i32) -> i32)
  if (isFnTraitType(expected.type) && isFnTraitType(given.type)) {
    return areFunctionTypesCompatible(
      { type: expected.type.isFn.callType, env: expected.env },
      { type: given.type.isFn.callType, env: given.env },
      requireExactMatch
    );
  }

  if (isFutureTraitType(expected.type) && isFutureTraitType(given.type)) {
    return areTypesCompatible(
      { type: expected.type.isFuture.outputType, env: expected.env },
      { type: given.type.isFuture.outputType, env: given.env }
    );
  }

  // Different ids = different modules (nominal typing)
  return false;
}
```

#### 2.2 Keep structural comparison for specific cases

- `FnTraitType` (closures): Compare by function signature
- `FutureTraitType` (futures): Compare by output type
- Anonymous modules in prelude: May need special handling

### Phase 3: Implement Duplicate Impl Detection

#### 3.1 Add impl tracking per type

Create a registry to track which modules are implemented for which types:

```typescript
// In module.ts or new file
interface ImplRecord {
  moduleTypeId: string;
  modulePath: string; // Where the impl was defined (for orphan rule)
  expr: Expr; // For error messages
}

// Map from type id to list of implemented modules
const typeImplRegistry: Map<string, ImplRecord[]> = new Map();
```

#### 3.2 Check for duplicates before adding impl

In `attachTraitToReceiverType` and generic impl registration:

```typescript
function checkDuplicateImpl(
  receiverType: Type,
  moduleType: ModuleType,
  currentModulePath: string,
  expr: Expr
): void {
  const typeId = receiverType.id;
  const impls = typeImplRegistry.get(typeId) || [];

  const existing = impls.find((impl) => impl.moduleTypeId === moduleType.id);
  if (existing) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage:
        `Module "${moduleType.typeName ?? moduleType.id}" is already implemented for type "${typeToString(receiverType)}".\n` +
        `First implementation was in: ${existing.modulePath}`,
    });
  }
}
```

### Phase 4: Implement Orphan Rule

#### 4.1 Add orphan rule check

```typescript
function checkOrphanRule(
  receiverType: Type,
  moduleType: ModuleType,
  currentModulePath: string,
  expr: Expr
): void {
  const moduleDefinedHere =
    moduleType.definedInModulePath === currentModulePath;
  const typeDefinedHere = isTypeDefinedInModule(
    receiverType,
    currentModulePath
  );

  if (!moduleDefinedHere && !typeDefinedHere) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage:
        `Orphan impl: Cannot implement foreign module "${moduleType.typeName}" for foreign type "${typeToString(receiverType)}".\n` +
        `At least one of the module or the type must be defined in this module.`,
    });
  }
}

function isTypeDefinedInModule(type: Type, modulePath: string): boolean {
  // Check if the type was defined in the given module
  // This requires tracking type origin similar to modules
  // For now, check if env.currentModulePath matches
  return type.definedInModulePath === modulePath;
}
```

#### 4.2 Add `definedInModulePath` to Type interface

```typescript
export interface Type {
  // ... existing fields ...

  /**
   * The module path where this type was defined.
   * Used for orphan rule checks.
   */
  definedInModulePath?: string;
}
```

### Phase 5: Update Related Functions

#### 5.1 Update `typeImplementsTrait`

In `src/evaluator/exprs/subtype_of.ts`:

- Change module matching to use id comparison instead of structural

#### 5.2 Update `findMatchingGenericImpl`

In `src/evaluator/values/module.ts`:

- Update matching logic to use nominal module comparison

#### 5.3 Update codegen

Files in `src/codegen/`:

- Update any module type comparisons to use id-based matching

### Phase 6: Handle Special Cases

#### 6.1 Built-in modules (Copy, Send, etc.)

These are defined in prelude.yo and should have well-known ids.
They're exempt from orphan rules (prelude is "local" to all code).

#### 6.2 Parameterized modules

Modules created from functions like `Container(T)` get unique ids per instantiation.
This is correct behavior - `Container(i32)` and `Container(string)` should be different.

#### 6.3 FnTraitType and FutureTraitType

Keep structural comparison for these because:

- They are anonymous/parameterized
- `Fn(x: i32) -> i32` should be the same regardless of parameter names

---

## Files to Modify

### Core Type System

- [x] `src/types/definitions.ts` - Add `definedInModulePath` field
- [ ] `src/types/compatibility.ts` - Change to nominal comparison
- [ ] `src/types/creators.ts` - Set `definedInModulePath` when creating types

### Evaluator

- [ ] `src/evaluator/types/module.ts` - Set origin when creating modules
- [ ] `src/evaluator/values/module.ts` - Add duplicate/orphan checks
- [ ] `src/evaluator/exprs/subtype_of.ts` - Update `typeImplementsTrait`
- [ ] `src/evaluator/builtins/impl_constraint.ts` - May need updates

### Context

- [ ] `src/evaluator/context.ts` - Ensure `currentModulePath` is available

### Tests

- [ ] Create test cases for:
  - Nominal module identity
  - Duplicate impl detection
  - Orphan rule violations
  - Valid impl scenarios

---

## Potential Breaking Changes

1. **Code relying on structural module equality** - Will break if comparing modules by structure
2. **External impls** - Code implementing foreign modules for foreign types will break

---

## Migration Strategy

1. **Phase 1-2**: Core changes (nominal typing)

   - Low impact on user code
   - Internal behavior change

2. **Phase 3**: Duplicate impl detection

   - Will surface existing duplicate impls as errors
   - May require user code changes

3. **Phase 4**: Orphan rule
   - Most impactful change
   - Consider a warning period before making it an error
   - Or make it opt-in via a compiler flag initially

---

## Questions to Resolve

1. **Should generic impls be subject to orphan rules?**

   - `impl(forall(T), Data(T), Copy())` - Data is local but T is any type

2. **How to handle re-exports?**

   - If module A re-exports module B's type, which module is "local"?

3. **Should prelude be exempt from orphan rules?**

   - Currently it has special handling for anonymous module impls

4. **Error recovery for duplicate impls during development?**
   - During hot reload, old impls need cleanup before re-evaluating

---

## Implementation Order

1. Add `definedInModulePath` to types (non-breaking)
2. Track module origin during creation (non-breaking)
3. Implement duplicate impl detection with clear error messages
4. Change `areTypesCompatible` to nominal for modules
5. Update related functions (`typeImplementsTrait`, etc.)
6. Add orphan rule checks
7. Add comprehensive tests
8. Update documentation

---

## Estimated Effort

- Phase 1-2: 2-3 hours
- Phase 3: 1-2 hours
- Phase 4: 1-2 hours
- Phase 5: 2-3 hours
- Phase 6: 1-2 hours
- Testing: 2-3 hours

**Total: ~10-15 hours**
