# Type Parameter Unification and Where Clause Constraints

This document describes a series of related issues with type parameter unification and where clause constraint resolution that were discovered and fixed.

## Issue 1: Type Mismatch for Identical Impl Types

### Problem

When comparing two types that appeared identical (`Impl(Fn(u : i32) -> i32)`), the type checker was reporting them as incompatible:

```yo
use_cb :: (fn(v : i32, cb : (Impl(Fn(u : i32) -> i32))) -> i32) {
  return cb(v);
};

a := 2;
x := use_cb(10, (u) => ((u + 1) + a)); // capture variable 'a'
```

Error:

```
Error: Type mismatch for parameter "cb":
    Expected: Impl(Fn(u : i32) -> i32)
    Got:   Impl(Fn(u : i32) -> i32)
```

### Root Cause

Two separate issues in `areTypesCompatible`:

1. **Cycle detection was commented out**: This caused infinite recursion when comparing recursive types like `Node(T)` which contains `Option(Self)`.

2. **Too-strict SomeType comparison**: When comparing two SomeTypes with the same name but different IDs, the code had a commented-out early return that would make them incompatible:
   ```typescript
   // return true;  // This was commented out
   ```
   After all the module compatibility checks passed, instead of returning `true`, the code fell through to environment resolution which failed.

### Solution

**File**: `src/types/compatibility.ts`

1. **Uncommented cycle detection** to handle recursive types:

   ```typescript
   // Cycle detection: only for types that can be recursive (struct, enum, union, object)
   // Don't apply to SomeType as the same SomeType ID can have different meanings in different contexts
   const expectedId = expected.type.id;
   const givenId = given.type.id;
   if (
     expectedId &&
     givenId &&
     (isStructType(expected.type) ||
       isEnumType(expected.type) ||
       isUnionType(expected.type)) &&
     (isStructType(given.type) ||
       isEnumType(given.type) ||
       isUnionType(given.type))
   ) {
     const pairKey = `${expectedId}:${givenId}`;
     if (visitedPairs.has(pairKey)) {
       return true;
     }
     visitedPairs.add(pairKey);
   }
   ```

2. **Removed the early return** after module compatibility checks, allowing SomeTypes with compatible constraints to be considered compatible.

### Test Case

```yo
{
  Option :: (fn(compt(T): Type) -> compt(Type))
    enum(
      None,
      Some(value: T)
    )
  ;

  Node :: (fn(compt(T): Type) -> compt(Type))
    object(
      value : T,
      next : Option(Self)
    )
  ;

  LinkedList :: (fn(compt(X): Type) -> compt(Type))
    object(
      head : Option(Node(X)),
      length : usize
    )
  ;
}
```

---

## Issue 2: Type Parameter Unification with requireExactMatch

### Problem

When calling methods on generic types, type parameters couldn't unify:

```yo
ArrayList :: (fn(compt(T): Type) -> compt(Type))
  object(
    _ptr : ?*(T),
    _length : usize,
    _capacity : usize,

    push :: (fn(self: Self, typed_ptr : *(T)) -> unit)({
      target_ptr := (typed_ptr &+ self._length);  // Error here
      return ();
    })
  );
```

Error:

```
Error: Type mismatch for parameter "self":
    Expected: *(T)
    Got:   *(T)
```

The issue was that `typed_ptr : *(T)` (where T is from ArrayList) couldn't match the `&+` operator's `self : Self` parameter (where Self = `*(T)` from `impl(forall(T : Type), *(T), ...)`).

### Root Cause

The `requireExactMatch` parameter was being used for two different purposes:

1. **Cache comparisons** - where we need strict type identity (`Point(T)` should NOT match `Point(i32)`)
2. **Method receiver matching** - where we need to allow type parameter unification (`*(T)` from impl should unify with `*(T)` from caller)

When `requireExactMatch=true` was set for method receivers, an early return in the SomeType comparison logic prevented type parameter unification:

```typescript
if (requireExactMatch && expected.type.name === given.type.name) {
  return false; // Too strict!
}
```

### Solution

**File**: `src/types/compatibility.ts`

Removed the early return that rejected SomeTypes with the same name but different IDs when `requireExactMatch=true`. Instead, let the code continue to check module constraints and other compatibility checks. Two type parameters with different IDs but compatible constraints should be allowed to unify, even with `requireExactMatch=true`.

```typescript
// Removed this block:
// if (requireExactMatch && expected.type.name === given.type.name) {
//   return false;
// }

// Instead, continue to check:
// 1. Module count matching (for requireExactMatch)
// 2. Module compatibility
// 3. resolvedConcreteType compatibility
```

This allows:

- `*(T)` from `impl(forall(T: Type), *(T), ...)` to unify with `*(T)` from `ArrayList(T)`
- While still preventing `i32` from matching `compt_int` (different code paths for primitive types)

The key insight: Even with `requireExactMatch=true`, type parameters can unify if they have compatible constraints. The "exact match" applies to the overall type structure, not to preventing generic type unification.

---

## Issue 3: Where Clause Constraint Lookup by Identity

### Problem

Method lookup was failing when the receiver type differed from the constrained type, even though they should be unified:

```yo
LinkedList :: (fn(compt(T): Type) -> compt(Type))(
  object(
    head : Option(Node(T)),

    has :: (fn(
      self: Self,
      value: T,
      where(T <: Eq(T))
    ) -> bool)({
      current_opt := self.head.unwrap();
      value == current_opt.value;        // This works
      current_opt.value == value;        // This doesn't work!
      false
    })
  )
)
```

Error:

```
Error: No matching call found with arguments:
(current_opt.value) == value
```

The first comparison `value == current_opt.value` worked because `value` has type `T` with the `Eq(T)` constraint. But the second comparison `current_opt.value == value` failed because `current_opt.value` has type `X` (from `Node(X)` definition), and `X` doesn't have the constraint even though it should be the same as `T`.

### Root Cause

The where clause constraint lookup used Map's direct key lookup with object identity:

```typescript
const constraints = currentFunctionType.whereClauseConstraints.get(
  dereferencedReceiverType
);
```

When `dereferencedReceiverType` is `X` (from Node) and the constraint was defined for `T` (from LinkedList's `has` method), they didn't match because they're different SomeType objects with different IDs.

### Solution

**File**: `src/env.ts` (method: `getMethodsByNameFromEnv`)

Modified the constraint lookup to iterate through all constraints and check type compatibility:

```typescript
// Look for methods in function-scoped where clause constraints
if (methods.length === 0 && currentFunctionType?.whereClauseConstraints) {
  // First try direct lookup
  let constraints = currentFunctionType.whereClauseConstraints.get(
    dereferencedReceiverType
  );

  // If direct lookup fails and receiver is a SomeType, try to find a compatible
  // constrained type parameter. This handles cases like:
  //   - where(T <: Eq(T)) in has method
  //   - current_opt.value has type X (from Node(X))
  //   - X should match T because they're unified type parameters
  if (!constraints && isSomeType(dereferencedReceiverType)) {
    for (const [
      constrainedType,
      typeConstraints,
    ] of currentFunctionType.whereClauseConstraints) {
      if (
        isSomeType(constrainedType) &&
        areTypesCompatible(
          { type: constrainedType, env },
          { type: dereferencedReceiverType, env },
          false // Allow type parameter unification
        )
      ) {
        constraints = typeConstraints;
        break;
      }
    }
  }

  if (constraints) {
    // ... use the constraints to find methods
  }
}
```

---

## Issue 4: Where Clause Constraints on Parent Functions

### Problem

When where clause constraints are defined on an outer function, inner methods couldn't access them:

```yo
HashMap :: (fn(
  compt(K): Type,
  compt(V): Type,
  where(K <: (Eq(K), Hash))  // Constraint on outer function
) -> compt(Type))
  object(
    _find_bucket :: (fn(self: Self, key: K) -> Option(usize))(
      {
        key == key;  // Error: can't find == operator for K
        .None
      }
    )
  );
```

Error:

```
Error: No matching call found with arguments:
key == key
```

The constraint `where(K <: (Eq(K), Hash))` is on `HashMap`, but `_find_bucket` needs to use methods from `Eq(K)`.

### Root Cause

The constraint lookup only checked `currentFunctionType.whereClauseConstraints`, which for `_find_bucket` was the method's own function type. It didn't traverse up to parent function types to find constraints defined on enclosing functions.

### Solution

**File**: `src/env.ts` (method: `getMethodsByNameFromEnv`)

Modified the constraint lookup to traverse the chain of parent function types:

```typescript
// Look for methods in function-scoped where clause constraints
// Also checks parent function types (for nested functions like methods inside generic types)
if (methods.length === 0) {
  // Helper function to find constraints from a function type
  const findConstraintsInFunction = (
    funcType: FunctionType | undefined
  ): { requiredModules: ModuleType[] } | undefined => {
    if (!funcType?.whereClauseConstraints) return undefined;

    // First try direct lookup
    let constraints = funcType.whereClauseConstraints.get(
      dereferencedReceiverType
    );

    // If direct lookup fails and receiver is a SomeType, try to find a compatible
    // constrained type parameter
    if (!constraints && isSomeType(dereferencedReceiverType)) {
      for (const [
        constrainedType,
        typeConstraints,
      ] of funcType.whereClauseConstraints) {
        if (
          isSomeType(constrainedType) &&
          areTypesCompatible(
            { type: constrainedType, env },
            { type: dereferencedReceiverType, env },
            false // Allow type parameter unification
          )
        ) {
          constraints = typeConstraints;
          break;
        }
      }
    }

    return constraints;
  };

  // Check current function and all parent functions in the chain
  let funcToCheck: FunctionType | undefined = currentFunctionType;
  while (funcToCheck && methods.length === 0) {
    const constraints = findConstraintsInFunction(funcToCheck);
    if (constraints) {
      // ... use constraints to find methods
    }
    // Move to parent function
    funcToCheck = funcToCheck.ParentFunctionType;
  }
}
```

Now when `_find_bucket` needs to find the `==` operator for `K`, it traverses up to `HashMap`'s function type and finds the `where(K <: (Eq(K), Hash))` constraint.

---

## Summary

These four related issues all stem from the type system's handling of generic type parameters:

1. **Cycle detection** was needed for recursive types to avoid infinite loops
2. **Type parameter unification** needed to work even with `requireExactMatch=true` to allow generic method calls
3. **Where clause constraints** needed compatibility-based lookup instead of identity-based lookup
4. **Parent function constraints** needed to be accessible from nested methods

The fixes ensure that:

- Generic types like `ArrayList(T)`, `LinkedList(T)`, and `HashMap(K, V)` work correctly
- Type parameters can unify across different scopes
- Where clause constraints are properly propagated through the type system
- Methods can access constraints defined on enclosing generic types

All fixes maintain the integrity of the type system while enabling proper generic programming patterns.
