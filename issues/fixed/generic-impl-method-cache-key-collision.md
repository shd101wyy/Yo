# genericImplMethodCache Key Collision Between Same-Named Types

## Summary

The `genericImplMethodCache` in `src/evaluator/values/impl.ts` used `typeToString(concreteType)` as part of its cache key. This caused collisions between different types that share the same short name (e.g., `std/imm/string.yo`'s `String` and `std/string.yo`'s `String`).

## Symptom

Compiling `Vec(ImmString)` (where ImmString = `std/imm/string.yo`'s `String`) failed with:

```
No matching call found with arguments: base_ptr &+ i
```

at `std/collections/array_list.yo:237`.

## Root Cause

1. `std/imm/string.yo` defines `String :: atomic object(...)` and `std/string.yo` defines `String :: object(...)`.
2. The pointer types `*(ImmString)` and `*(std::String)` both produce `typeToString = "*(String)"`.
3. The `genericImplMethodCache` key was `typeToString(concreteType) + "\0" + methodName`.
4. When `*(ImmString)`'s methods were cached first, a subsequent lookup for `*(std::String)` hit the cache and returned ImmString's methods.
5. `filterMethodsByReceiverType` then rejected all methods (wrong receiver type) → 0 candidates → error.

## Fix

Changed the cache key from `typeToString(concreteType)` to `concreteType.id`:

```typescript
// Before (buggy):
const cacheKey = typeToString(concreteType) + "\0" + methodName;

// After (fixed):
const cacheKey = concreteType.id + "\0" + methodName;
```

Type IDs are globally unique (include module hash + counter), so they cannot collide across modules.

### Secondary Fix: Template Type in context.types

Using `concreteType.id` exposed a second issue: type functions like `MapBranch(K, V)` create new struct instances with random IDs per invocation, so the cache misses on every call. This is a performance issue, not a correctness bug.

However, template types (with unresolved forall SomeType fields) appear in `context.types` and get processed by `collectDisposeMethodsFromGenericImpls`. When `tryMatchGenericImpl` matches a template against its own impl's forall params, no real substitutions are produced (SomeType matches itself). The code would then try to evaluate the function body without the forall variables in scope, crashing with "Variable K not found".

Added a `hasMissingForallParams` guard:

```typescript
const hasMissingForallParams = impl.forallParameters.some(
  (p) => p.kind === "type" && !match.substitutions.has(p.name)
);
```

When this is true, the method is skipped entirely — the template type cannot be specialized.

## Files Changed

- `src/evaluator/values/impl.ts`: Cache key change + hasMissingForallParams guard

## Test Coverage

- `tests/imm_vec.test.yo`: Includes Vec(ImmString) tests
- `tests/imm_map.test.yo`: Includes Map(K, V) tests (exercises type function cache)
- `tests/imm_threading.test.yo`: Cross-thread Vec(ImmString) usage
