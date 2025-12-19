# Recursive Type Generation via `recur`

## Issue

When a compile-time function that returns `compt(Type)` uses `recur` to create recursive type definitions, it creates a chicken-and-egg problem during evaluation:

```yo
Worker :: (fn(compt(A) : Type, compt(B) : Type) -> compt(Type)) {
  Child :: recur(B, A);  // Child = Worker(B, A)
  
  object(
    ptr : *(void),
    _test :: (fn(v : *(void)) -> unit)({
      Self(v);   // OK: Self is available via context.SelfType
      Child(v);  // ERROR: Child is a SomeType placeholder
    })
  )
};
```

### Evaluation Flow

1. `Worker(i32, u32)` evaluation starts
2. Temp cache created with SomeType placeholder (to prevent infinite recursion)
3. Body evaluation:
   - `Child :: recur(B, A)` calls `Worker(u32, i32)`
   - `Worker(u32, i32)` creates its own temp cache with SomeType
   - Inside `Worker(u32, i32)`, `recur(A, B)` calls `Worker(i32, u32)`
   - Finds temp cache from step 2, returns SomeType placeholder
   - `Child` is bound to this SomeType
   - Tries to evaluate `_test` function body (for type-checking)
   - `Child(v)` fails: SomeType is not callable as a constructor

### Root Cause

The temp cache mechanism (in `evaluateComptFunctionCall`) prevents infinite recursion by storing a SomeType placeholder with `recursiveTypeRef`. However, when the recursive call happens before the cache is populated with the actual type, any code trying to use that type as a constructor gets the placeholder.

## Solution

We resolve recursive type references by using the `context.SelfType` as a template. Key insight: all instantiations of the same type-generating function produce the same type structure, just with different type parameter bindings.

### Implementation

1. **Added `recursiveTypeRef` field to `SomeType`** (`src/types/definitions.ts`):
   ```typescript
   recursiveTypeRef?: {
     functionValue: FunctionValue;
     argValues: Value[];
   };
   ```

2. **Store recursive reference info when creating placeholder** (`src/evaluator/calls/compt_function.ts`):
   ```typescript
   value: createUnknownValue(
     functionType.return.type,
     functionType.return.label,
     { functionValue, argValues }  // Store for later resolution
   ),
   ```

3. **Resolve before type-checking** (`src/evaluator/calls/function.ts`):
   ```typescript
   function resolveRecursiveTypeRef(someType, callerEnv, context) {
     // Try to find resolved type in cache
     const cache = functionValue.calledComptFunctionCaches.find(...);
     
     if (cache && isTypeValue(cache.value)) {
       if (isSomeType(cache.value.value) && cache.value.value.recursiveTypeRef) {
         // Cache still has placeholder - use SelfType as template
         if (context?.SelfType && isObjectType(context.SelfType)) {
           return context.SelfType;
         }
       }
       return cache.value.value;
     }
     
     // Not in cache yet - use SelfType if available
     if (context?.SelfType && isObjectType(context.SelfType)) {
       return context.SelfType;
     }
   }
   ```

### Why This Works

- `Worker(A, B)` and `Worker(B, A)` produce the same type structure: `object(ptr : *(void), _test :: ...)`
- Type parameters only affect the *bindings* within that structure, not the structure itself
- When evaluating `Worker(u32, i32)` and encountering `Child` (which is `Worker(i32, u32)`), we can use the current `SelfType` (the object type being defined) as the resolved type
- The actual type parameter bindings are handled correctly because each instantiation has its own evaluation environment

## Comparison with Other Languages

### Rust
Rust doesn't have compile-time type-generating functions. Recursive types require indirection:
```rust
// Error: recursive type has infinite size
struct Node { child: Node }

// OK: Box provides indirection
struct Node { child: Box<Node> }
```

Type aliases with swapped parameters are allowed:
```rust
type Swap<A, B> = (A, Swap<B, A>);  // OK in type aliases
```

### Zig
Zig has comptime functions that can generate types, but uses a different evaluation model that doesn't have this issue.

### TypeScript
TypeScript's type system is declarative, not evaluative. Recursive types are allowed through nominal references:
```typescript
type Worker<A, B> = {
  child: Worker<B, A>;  // OK: nominal reference
}
```

## Limitations

This solution works because:
1. The recursive type has the same structure across all instantiations
2. We're in a context where `SelfType` is available (inside struct/object definition)

It wouldn't work for cases where:
- The type structure fundamentally changes based on type parameters
- We're outside a type definition context (no `SelfType`)

For those cases, additional mechanisms would be needed (e.g., lazy type evaluation, suspension points).
