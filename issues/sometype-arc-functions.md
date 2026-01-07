# SomeType ARC Functions (**_dup and _**drop)

## Problem

When a `SomeType` (used for `Impl(Fn(...))` closures) is stored in a container like `Box(V)`, the container needs to properly manage the memory of its contents. Specifically:

1. **Box's `___dispose`** should call `___drop` on its field to decrement reference counts
2. **Box's constructor** should call `___dup` on the value to increment reference counts when copying

However, `SomeType` is an abstract type - at evaluation time, we don't know the concrete type it will resolve to. This caused two issues:

### Issue 1: `typeContainsRcType(SomeType)` returned `false`

The `typeContainsRcType` function determines whether a type needs ARC management. Since `SomeType` doesn't have a known structure at generation time, it was returning `false`, causing Box's `___dispose` to not generate `___drop` calls for SomeType fields.

**Fix**: Changed `typeContainsRcType` to conservatively return `true` for `SomeType`, ensuring containers always generate proper cleanup code.

### Issue 2: No ARC dispatch mechanism for SomeType

Even after fixing `typeContainsRcType`, calling `___drop` on a SomeType value didn't work because:

- The codegen handles `___drop` as a builtin function
- For value types, it returned empty string (no-op)
- SomeType is technically a value type (its `resolvedConcreteType` is often a value struct like a closure capture)

**Fix**: Added special handling in codegen's `___drop` builtin to check if the type is a SomeType with a `resolvedConcreteType`, and if so, dispatch to the concrete type's `___drop` function.

## Solution

### 1. Added `__yo_sometype_drop` and `__yo_sometype_dup` builtins

These builtins dispatch to the `resolvedConcreteType`'s methods at codegen time:

```typescript
// In codegen/expressions/generation.ts
if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_sometype_drop)) {
  const argType = selfArg.$?.type;
  if (argType && isSomeType(argType) && argType.resolvedConcreteType) {
    // Dispatch to concrete type's ___drop
    const concreteType = argType.resolvedConcreteType;
    const dropFn = concreteType.module?.fields.find(
      (f) => f.label === "___drop"
    );
    // ... generate call to dropFn
  }
}
```

### 2. Added ARC functions to SomeType's module

When a `SomeType` is created, we add `___drop` and `___dup` methods that call the builtins:

```typescript
function generateDropFunctionCodeForSomeType(someType: SomeType): string {
  return `((fn(self : Self) -> unit) {
    __yo_sometype_drop(self);
  })`;
}
```

### 3. Updated `___drop` builtin handling in codegen

Added a check for SomeType before the "value types: no-op" fallback:

```typescript
// For SomeType with resolvedConcreteType, dispatch to the concrete type's ___drop
if (isSomeType(valueType) && valueType.resolvedConcreteType) {
  const concreteType = valueType.resolvedConcreteType;
  const dropFn = concreteType.module?.fields.find((f) => f.label === "___drop");
  // ... generate call
}
```

### 4. Fixed field label sanitization

Field labels like `*` (used by `Box`) are not valid identifiers. The generated code now uses aliased destructuring:

```yo
// Before (broken):
{ * } := self;
(___drop)(*);

// After (fixed):
{ (*) : _u42_ } := self;
(___drop)(_u42_);
```

### 5. Fixed `dispose_fn` in constructors

The `dispose_fn` pointer in object headers was only set for user-defined `dispose` methods. Changed to use `___dispose` which properly:

1. Calls user's `dispose` if it exists
2. Drops all fields with GC types

## Memory Flow Example

For `Box(Impl(Fn(...)))` containing a capture struct with `MyBox`:

```
1. Dyn's ___drop → decrements Box's ref count
2. Box's ref count = 0 → __yo_decr_rc calls Box's ___dispose
3. Box's ___dispose → calls ___drop on SomeType field
4. SomeType's ___drop → dispatches to capture struct's ___drop
5. Capture struct's ___drop → decrements MyBox's ref count
6. MyBox's ref count = 0 → calls MyBox's ___dispose
7. MyBox's ___dispose → calls user's dispose, then frees
```

## Files Modified

- `src/expr.ts` - Added `__yo_sometype_drop`, `__yo_sometype_dup` builtins
- `src/types/utils.ts` - Made `typeContainsRcType(SomeType)` return `true`
- `src/evaluator/types/utils.ts` - Added `addRcFunctionsToSomeType`, fixed field label sanitization
- `src/codegen/expressions/generation.ts` - Added codegen for SomeType ARC builtins
- `src/codegen/types/generation.ts` - Fixed `dispose_fn` to use `___dispose`
