# Recursive Type Generation via `recur`

## Issue

When a compile-time function that returns `comptime(Type)` uses `recur` to create recursive type definitions, it creates a chicken-and-egg problem during evaluation:

```yo
Worker :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type)) {
  Child :: recur(B, A);  // Child = Worker(B, A)

  // Case 1: Using Child INSIDE object definition (has SelfType)
  object(
    raw : *(void),
    _test :: (fn(v : *(void)) -> unit)({
      Self(v);   // OK: Self is available via context.SelfType
      Child(v);  // Was ERROR, now OK with SelfType resolution
    })
  )
};

// Case 2: Using Child OUTSIDE object definition (no SelfType)
Worker2 :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type)) {
  Child :: recur(B, A);

  internal_wrapper :: (fn(raw : *(void)) -> unit) {
    Child(raw);  // Was ERROR, now OK with deferred constructor call
  };

  object(raw : *(void))
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
   - Tries to evaluate function body (for type-checking)
   - `Child(v)` fails: SomeType is not callable as a constructor

### Root Cause

The temp cache mechanism (in `evaluateComptimeFunctionCall`) prevents infinite recursion by storing a SomeType placeholder with `recursiveTypeRef`. However, when the recursive call happens before the cache is populated with the actual type, any code trying to use that type as a constructor gets the placeholder.

## Solution

Two complementary strategies handle recursive type references:

### Strategy 1: Resolve via SelfType (inside object/struct definition)

When inside an object/struct definition, use `context.SelfType` as a template. Key insight: all instantiations of the same type-generating function produce the same type structure.

### Strategy 2: Deferred Constructor Call (outside object definition)

When outside an object definition (no SelfType available), allow the SomeType to be used as a constructor by:

1. Evaluating the arguments for type-checking
2. Setting the expression's type to the SomeType
3. Letting the actual type resolution happen later

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
     // Strategy 1: Look for exact matching cache entry with resolved type
     const exactCache = functionValue.calledComptimeFunctionCaches.find(...);
     if (exactCache && !isSomeType(exactCache.value.value)) {
       return exactCache.value.value;
     }

     // Strategy 2: Use context.SelfType if available
     if (context?.SelfType && isObjectType(context.SelfType)) {
       return context.SelfType;
     }

     // Strategy 3: Look for ANY resolved cache entry (same structure)
     const anyResolvedCache = functionValue.calledComptimeFunctionCaches.find(...);
     if (anyResolvedCache) {
       return anyResolvedCache.value.value;
     }

     return undefined;  // Will use deferred constructor call
   }
   ```

4. **Handle unresolved SomeType as deferred constructor** (`src/evaluator/calls/function.ts`):
   ```typescript
   // When SomeType has recursiveTypeRef and can't be resolved yet:
   // - Evaluate arguments to type-check them
   // - Return a "type" result with the SomeType
   // - Set expr.$.type to the SomeType for the constructed value
   if (isSomeType(wrapperType) && wrapperType.recursiveTypeRef) {
     // Evaluate arguments for type-checking
     for (const argExpr of argsToUse) {
       const evaluatedArg = evaluateExpression({ expr: argExpr, env, context });
       runtimeArgExprsInOrder.push(evaluatedArg);
     }
     return {
       kind: "type",
       result: { values, pathCollection, runtimeArgExprsInOrder, callerEnv },
     };
   }
   ```

### Why This Works

**For Strategy 1 (SelfType resolution):**

- `Worker(A, B)` and `Worker(B, A)` produce the same type structure
- Type parameters only affect the _bindings_ within that structure, not the structure itself
- The actual type parameter bindings are handled correctly because each instantiation has its own evaluation environment

**For Strategy 2 (Deferred constructor):**

- The SomeType placeholder carries enough information (recursiveTypeRef) to identify what type it will become
- During function body validation, we only need to know the type structure for type-checking
- The actual type resolution happens when the enclosing comptime function completes and updates the cache

## Comparison with Other Languages

### Rust

Rust doesn't have compile-time type-generating functions. Recursive types require indirection:

```rust
// Error: recursive type has infinite size
struct Node { child: Node }

// OK: Box provides indirection
struct Node { child: Box<Node> }
```

### Zig

Zig has comptime functions that can generate types, but uses a different evaluation model that doesn't have this issue.

### TypeScript

TypeScript's type system is declarative, not evaluative. Recursive types are allowed through nominal references:

```typescript
type Worker<A, B> = {
  child: Worker<B, A>; // OK: nominal reference
};
```

## Current Status

✅ **Implemented and working:**

- Recursive type references inside object/struct definitions (SelfType resolution)
- Recursive type references outside object definitions (deferred constructor call)
- Type-checking of arguments when calling recursive type as constructor

## Test Case

```yo
Worker :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type)) {
  Child :: recur(B, A);

  internal_wrapper :: (fn(raw : *(void)) -> unit) {
    Child(raw);  // ✅ Now works with deferred constructor call
  };

  object(raw : *(void))
};
```
