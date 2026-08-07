# Unified Compile-Time Design

## Overview

This document proposes simplifying Yo's compile-time semantics by:

1. Removing the `::` binding operator (compile-time only `:=`)
2. Automatically storing compile-time values when available
3. Making `comptime` a constraint keyword for function parameters only

## Inspiration: Zig's Approach

Zig handles compile-time execution elegantly:

```zig
// Zig: comptime parameter - must be known at compile time
fn multiply(comptime a: i32, b: i32) i32 {
    return a * b;
}

// Zig: comptime block - forces compile-time evaluation
const x = comptime blk: {
    var sum: i32 = 0;
    for (0..10) |i| {
        sum += i;
    }
    break :blk sum;
};

// Zig: automatic - if all inputs are comptime, runs at comptime
fn factorial(n: u64) u64 {
    if (n == 0) return 1;
    return n * factorial(n - 1);
}
const fact_10 = factorial(10); // Evaluated at compile time
```

Key Zig insights:

- No separate `const` vs `var` for compile-time storage - it's inferred
- `comptime` on parameters = constraint that value must be known at call site
- Functions automatically run at compile-time when all inputs are compile-time known

## Current Yo Design

```rust
// :: = compile-time binding (value MUST be known)
PI :: 3.14159;
MyType :: i32;

// := = runtime binding (value stored even if known at compile-time)
radius := 5.0;  // Could be compile-time, but marked as runtime

// comptime in parameters
generic_fn :: (fn(comptime(T) : Type, x : T) -> T) { ... };
```

**Problems:**

1. Users must decide `::` vs `:=` - cognitive overhead
2. Inconsistent with "CTFE when possible" philosophy
3. `comptime_assert` exists separately from `assert`

## Proposed Design

### 1. Remove `::`, Keep Only `:=`

```rust
// Before
PI :: 3.14159;
MyType :: i32;

// After - same syntax for everything
PI := 3.14159;      // Automatically compile-time (value is literal)
MyType := i32;      // Automatically compile-time (type value)
```

**Implementation:**

- In `initialization_assignment.ts`: Always check if RHS has a compile-time value
- If `evaluatedRhs.$.value !== undefined`, store it in the variable
- Variable's `isCompileTimeOnly` becomes an optimization hint, not a user choice

### 2. `comptime` for Parameter Constraints Only

```rust
// comptime(T) means: T must be compile-time known at call site
// Used for generics and type-level programming
Array :: (fn(comptime(T) : Type, comptime(N) : usize) -> Type)
  struct(
    data : [T; N]
  )
;

// Call site - arguments must be compile-time known
IntArray5 := Array(i32, 5);  // OK: i32 and 5 are compile-time known
// Array(i32, get_size())    // ERROR: get_size() is not compile-time known
```

**Semantics:**

- `comptime(x) : Type` = parameter `x` has `UnknownValue` (not `undefined`)
- This means: "x is compile-time, but its specific value isn't known during function body analysis"
- At call site: argument must have `value !== undefined`

## Implementation Plan

### Phase 1: Unify Variable Binding

Modify `initialization_assignment.ts`:

```typescript
// Remove treatAsCompileTimeBinding checks
// Always store value if available:

const valueToStore = evaluatedRhs.$.value; // Store if defined
const isCompileTimeOnly = valueToStore !== undefined;

env = addVariableToEnv({
  env,
  variable: {
    name: variableName,
    type: variableType,
    value: valueToStore ? [valueToStore] : undefined,
    isCompileTimeOnly,
    // ... other fields
  },
});
```

### Phase 2: Simplify `comptime` in Parameters

In `binding.ts` and `helper.ts`:

- `comptime(x)` creates parameter with `isCompileTimeOnly: true`
- During call: verify argument has `value !== undefined`
- Store `UnknownValue` for function body analysis, actual value for CTFE execution

## Migration Guide

```rust
// Old code
PI :: 3.14159;
MyType :: i32;
value :: some_pure_fn(10);

// New code - works the same
PI := 3.14159;
MyType := i32;
value := some_pure_fn(10);
```

## Comparison Table

| Aspect               | Current Yo    | Proposed Yo   | Zig                  |
| -------------------- | ------------- | ------------- | -------------------- |
| Compile-time binding | `::`          | `:=` (auto)   | `const`/`var` (auto) |
| Runtime binding      | `:=`          | `:=` (auto)   | `var`                |
| Param constraint     | `comptime(x)` | `comptime(x)` | `comptime x`         |

## Benefits

1. **Simpler Mental Model**: One binding operator, compiler figures out the rest
2. **Zig-Like Ergonomics**: Users familiar with Zig will feel at home
3. **Fewer Keywords**: Remove `::`
4. **CTFE Philosophy Alignment**: "Compile-time when possible" is now consistent

## Potential Concerns

| Concern                  | Mitigation                                |
| ------------------------ | ----------------------------------------- |
| Can't force compile-time | Good error messages                       |
| Breaking change          | Yo is evolving, `::` → `:=` is mechanical |

## Open Questions

1. Should we keep `comptime_print` for debugging, or unify with `println`?
2. Do we need a way to force runtime evaluation? (Probably not - just use a function that has runtime side effects)
3. Should `comptime_string` become just `str` that's compile-time known?

## Timeline

- Phase 1 (unify binding): 2-3 days
- Phase 2 (simplify comptime): 1 day
- Testing & migration: 2-3 days

Total: ~1 week
