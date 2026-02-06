# Comptime Function Cache: SomeType Identity Comparison Issue

## Status

**RESOLVED** - Fixed in comptime_function.ts

## Summary

The compile-time function cache was incorrectly treating different SomeTypes as equal when they had compatible structures, causing wrong cached results to be returned. This led to generic type instantiations losing trait constraints from where clauses.

## The Bug

When evaluating generic impls with where clause constraints, calling a generic type constructor would return a cached result with the wrong type parameter, losing the trait constraints.

### Example

```yo
Box :: (fn(comptime(V) : Type) -> comptime(Type))
  object((*) : V)
;

impl(forall(T : Type), where(T <: Hash), Box(T), Hash(
  (hash) : ((self) -> {
    d := self.*;  // d : Box(T)
    v := d.*;     // v should be T (with Hash constraint)
    return v.hash();  // ERROR: No matching call found
  })
));
```

**Expected behavior:** `v` should have type `T` which has the `Hash` constraint from `where(T <: Hash)`, allowing `v.hash()` to succeed.

**Actual behavior:** `v` has type `V` (Box's original type parameter) without any Hash constraint, causing `v.hash()` to fail.

## Root Cause

The compile-time function cache comparison in `evaluateComptimeFunctionCall` was using `areTypesCompatible` to compare SomeType arguments:

```typescript
// OLD (INCORRECT) CODE:
if (isTypeValue(argValue) && isTypeValue(givenArgValue)) {
  if (isSomeType(argValue.value)) {
    if (!isSomeType(givenArgValue.value)) {
      return false;
    }
  }

  // This would match ANY two SomeTypes that are structurally compatible!
  return areTypesCompatible(
    { type: argValue.value, env: cache.env },
    { type: givenArgValue.value, env: callerEnv },
    true
  );
}
```

### The Problem

1. **First call:** `Box(V)` is called during Box's definition with the SomeType `V` (id: `sometype_..._23974`)

   - Cache stores: `{ argValues: [TypeValue(V)], value: Box(V) }`

2. **Second call:** `Box(T)` is called in the impl body where `T <: Hash` (id: `sometype_..._24029`)

   - `T` has Hash constraint in its `trait.fields`
   - Cache lookup compares `V` vs `T` using `areTypesCompatible`
   - **BUG:** `areTypesCompatible` returns `true` because both are SomeTypes with compatible structure
   - Cache returns the stored `Box(V)` result instead of creating new `Box(T)`

3. **Result:** Field access on `Box(T)` returns type `V` without Hash constraint, not `T` with Hash constraint

### Why areTypesCompatible Was Wrong Here

`areTypesCompatible` is designed to check if one type can be used where another is expected (e.g., for function calls, assignments). It treats different SomeTypes as compatible if they can unify or match structurally.

However, **for caching purposes, we need identity equality, not compatibility**. Two different SomeType instances (even if structurally similar) represent different type parameters and must create separate cache entries.

Consider:

- `V` from Box's definition: A type parameter in the scope of Box's function body
- `T` from impl's forall: A different type parameter in the scope of the impl body with specific constraints

These are **not the same type parameter** even though they're both SomeTypes. They have different scopes, different constraints, and different identities.

## The Fix

Compare SomeTypes by their unique `id` field instead of using structural compatibility:

```typescript
// NEW (CORRECT) CODE:
if (isTypeValue(argValue) && isTypeValue(givenArgValue)) {
  // CRITICAL: For SomeTypes, we must compare by id, not by name or structure.
  // Two different SomeTypes (e.g., V from Box's definition and T from impl's forall)
  // should NOT be considered equal even if they have the same structure.
  // This ensures that Box(V) and Box(T) create separate cache entries.
  if (isSomeType(argValue.value) && isSomeType(givenArgValue.value)) {
    // Must be the exact same SomeType instance
    return argValue.value.id === givenArgValue.value.id;
  }

  if (isSomeType(argValue.value)) {
    if (!isSomeType(givenArgValue.value)) {
      return false;
    }
  }

  // For non-SomeType types, use structural comparison
  return areTypesCompatible(
    { type: argValue.value, env: cache.env },
    { type: givenArgValue.value, env: callerEnv },
    true
  );
}
```

## Why This Fix Works

### Cache Behavior After Fix

1. **First call:** `Box(V)` with SomeType id `sometype_..._23974`

   - Cache stores: `{ argValues: [TypeValue(V with id 23974)], value: Box(V) }`

2. **Second call:** `Box(T)` with SomeType id `sometype_..._24029`

   - Cache lookup compares: `23974 === 24029` → `false`
   - **Cache miss!** Create new entry for `Box(T)`
   - Box's body is re-evaluated with `V = T` in the environment
   - The returned `Box(T)` has field type `V` which resolves to `T` in that environment
   - `T` has the Hash constraint, so field access works correctly

3. **Result:** `Box(T)` has its own cache entry, field access returns `T` with Hash constraint

### Why ID Comparison Is Correct

Each SomeType has a unique `id` generated when it's created (e.g., from `forall` parameters, type parameter declarations). This `id` represents the **identity** of that specific type parameter instance:

- **Same `id`**: Same type parameter instance → can use cached result
- **Different `id`**: Different type parameter instances (even with same name/structure) → must create new cache entry

This ensures that:

- `Box(T)` where `T <: Hash` gets a separate cache entry from `Box(V)`
- `Box(T)` where `T <: Eq` gets a separate cache entry from `Box(T)` where `T <: Hash`
- Each unique type parameter instantiation gets its own properly typed result

## Impact

This fix ensures that:

1. Generic type constructors properly maintain type parameter constraints
2. Where clause constraints are preserved through generic type instantiation
3. Method calls on generic type fields work correctly with trait constraints
4. Cache entries are properly isolated by type parameter identity

## Related Issues

- Similar to #file:SPECIALIZATION_CACHE_PITFALL.md but for compile-time function caching
- Related to #file:type-parameter-unification-and-where-clause-constraints.md regarding where clause constraint handling

## Testing

The fix was verified with the following test case in `fixme.yo`:

```yo
x := Box(u64)(42);
y := x.hash();  // Now works correctly
```

This test exercises:

1. Box instantiation with a concrete type (u64)
2. Generic impl matching for Box(T) where T <: Hash
3. Field access on the Box returning type T
4. Method call on T using the Hash trait constraint
