# Specialization Cache Pitfall with SomeType Mutation

## Summary

A bug occurred where the C compiler reported "incompatible type" errors when using `dyn(box(...))` pattern with closures. The root cause was that the specialization cache was being polluted during the "checking phase" of function call resolution.

## The Bug

When compiling code like:

```yo
closure := dyn(box(y => x.*))
```

The generated C code would have type mismatches like:

```
error: incompatible type for argument 1 of '_yostructid123_f___dup'
note: expected 'struct _yostructid123' but argument is of type 'struct _yostructid456'
```

Two different capture struct types were being generated with the same shape but different IDs.

## Root Cause

### Two-Phase Function Call Resolution

In `function.ts`, when resolving overloaded function calls, the evaluator uses a two-phase approach:

1. **Checking Phase**: Call `tryToCallFunctionWithArguments` with **cloned expressions** to test if each candidate function's parameters match the arguments. This is done to avoid modifying the original expressions.

2. **Actual Call Phase**: Call `tryToCallFunctionWithArguments` again with the **original expressions** to actually perform the function call.

### The Problem

When evaluating `dyn(box(closure))`:

1. **Checking Phase** (with cloned exprs):

   - Creates capture struct type A (e.g., `structid123`)
   - Mutates `SomeType.resolvedConcreteType = structTypeA`
   - **Caches** the specialized function with `structTypeA`

2. **Actual Call Phase** (with original exprs):
   - Creates capture struct type B (e.g., `structid456`) - different ID because `randomId()` generates new IDs
   - Mutates `SomeType.resolvedConcreteType = structTypeB`
   - **Cache HIT** - returns the cached function that expects `structTypeA`
   - But the actual code uses `structTypeB`!

### Why Cache Hit Occurred

The `SomeType` object is **shared** between phases. When comparing cache entries using `areValuesEqual`, the comparison looks at the `SomeType` object. Since the same object is used (just mutated), the cache lookup succeeds even though `resolvedConcreteType` has changed.

## The Fix

### Solution: `skipSpecialization` Flag

Added a `skipSpecialization?: boolean` parameter to `tryToCallFunctionWithArguments`:

```typescript
// In function.ts - checking phase
const result = tryToCallFunctionWithArguments({
  // ... other params
  skipSpecialization: true, // Don't pollute cache during checking
});

// In function.ts - actual call phase
const result = tryToCallFunctionWithArguments({
  // ... other params
  // skipSpecialization defaults to false - do specialize
});
```

When `skipSpecialization: true`:

- The function still evaluates to check parameter compatibility
- But it **skips** creating/using the specialization cache
- No cache entry is created with the intermediate capture struct

### Why This Works

- **Checking phase**: Creates intermediate capture struct, mutates SomeType, but no cache entry
- **Actual call phase**: Creates final capture struct, mutates SomeType, creates correct cache entry
- Future calls: Cache hit returns function with correct capture struct type

## Files Changed

- `src/evaluator/calls/helper.ts`: Added `skipSpecialization` parameter and logic
- `src/evaluator/calls/function.ts`: Pass `skipSpecialization: true` during checking phase
- `src/evaluator/calls/closure_type.ts`: Added explanatory comment about safe mutation pattern

## Lessons Learned

1. **Avoid in-place mutation of shared type objects** when possible
2. **Be careful with caching** when expressions are evaluated multiple times
3. **Checking/validation phases should be side-effect free** - they shouldn't create cached artifacts
4. **Use `cloneExpr` doesn't clone types** - the type objects are still shared references

## Alternative Solutions Considered

1. **Track `resolvedConcreteTypeIds` in cache**: Store the concrete type IDs at cache creation time and invalidate on mismatch. This was initially implemented but is more complex and error-prone.

2. **Don't mutate SomeType**: Create a new SomeType object instead of mutating. This would require tracking and replacing all references to the old SomeType, which is impractical.

3. **`skipSpecialization` (chosen)**: The simplest and most correct solution - checking phase shouldn't have side effects anyway.
