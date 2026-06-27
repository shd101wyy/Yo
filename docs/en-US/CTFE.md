# Compile-Time Function Evaluation (CTFE)

Yo performs **Compile-Time Function Evaluation** (CTFE) whenever possible to improve runtime performance. This document describes Yo's CTFE capabilities and how they compare to other languages.

## Overview

CTFE allows the compiler to execute functions at compile-time when all inputs are known at compile-time. The result is embedded directly into the generated code, eliminating runtime computation.

```rust
// This function can be evaluated at compile-time
factorial :: (fn(n : i32) -> i32) {
  result := i32(1);
  i := i32(1);
  while i <= n, {
    result = (result * i);
    i = (i + 1);
  };
  return result;
};

// The compiler evaluates factorial(10) at compile-time
// The generated code simply contains the constant 3628800
value :: factorial(10);
```

## Key Features

### 1. Automatic CTFE Analysis

Yo automatically analyzes functions to determine if they can be evaluated at compile-time. When a function is called with all compile-time known arguments, Yo attempts to execute it during compilation.

```rust
// No special annotation needed - Yo automatically detects
// that this can be evaluated at compile-time
sum_squares :: (fn(n : i32) -> i32) {
  result := i32(0);
  i := i32(1);
  while i <= n, {
    result = (result + (i * i));
    i = (i + 1);
  };
  return result;
};

// Evaluated at compile-time: 1 + 4 + 9 + 16 + 25 = 55
total :: sum_squares(5);
```

### 2. Full Control Flow Support

Yo's CTFE supports all control flow constructs:

- **`while` loops** with mutable loop variables
- **`continue`** to skip iterations
- **`break`** to exit loops early
- **`return`** for early function exit
- **`cond`** (conditional expressions)
- **`match`** (pattern matching)

```rust
// Example: Sum only odd numbers using continue
sum_odd :: (fn(max : i32) -> i32) {
  result := i32(0);
  i := i32(0);
  while i < max, {
    i = (i + 1);
    cond(
      ((i % 2) == 0) => continue,  // Skip even numbers
      true => {
        result = (result + i);
      }
    );
  };
  return result;
};

// Evaluated at compile-time: 1 + 3 + 5 + 7 + 9 = 25
odd_sum :: sum_odd(10);
```

### 3. First-Class Types

Types are values in Yo, enabling powerful compile-time type manipulation:

```rust
// Create a generic container type at compile-time
Container :: (fn(comptime(T) : Type) -> comptime(Type))
  ref(struct(
    value : T
  ))
;

// Types are computed at compile-time
IntContainer :: Container(i32);
StringContainer :: Container(String);
```

### 4. Compile-Time Assertions

Use `comptime_assert` to verify conditions at compile-time:

```rust
fib :: (fn(n : i32) -> i32) {
  cond(
    (n <= 1) => n,
    true => (fib((n - 1)) + fib((n - 2)))
  )
};

// These assertions are checked at compile-time
comptime_assert(fib(0) == 0);
comptime_assert(fib(1) == 1);
comptime_assert(fib(10) == 55);
```

### 5. Compile-Time Parameters

Use `comptime` to require compile-time known parameters:

```rust
// T must be known at compile-time for monomorphization
Array :: (fn(comptime(T) : Type, comptime(N) : usize) -> comptime(Type))
  struct(
    data : [T; N]
  )
;

// Create a fixed-size array type
IntArray5 :: Array(i32, 5);
```

## Comparison with Rust

Yo's CTFE is more flexible than Rust's `const fn` in several ways:

| Feature                    | Yo                            | Rust                              |
| -------------------------- | ----------------------------- | --------------------------------- |
| Mutable variables in loops | ✅ Yes                        | ✅ Yes (since 1.46)               |
| `while` loops              | ✅ Yes                        | ✅ Yes (since 1.46)               |
| `continue`/`break` in CTFE | ✅ Yes                        | ✅ Yes (since 1.46)               |
| Automatic CTFE inference   | ✅ Yes                        | ❌ Requires `const fn` annotation |
| First-class types          | ✅ Yes                        | ❌ No (uses generics/macros)      |
| Runtime fallback           | ✅ Same code works at runtime | ⚠️ Must duplicate for runtime     |
| Trait methods in const     | ✅ N/A (uses different model) | ⚠️ Limited (`const impl`)         |

### Key Advantages

1. **No Annotation Required**: In Yo, you don't need to mark functions as `const fn`. The compiler automatically determines if a function can be evaluated at compile-time based on its inputs.

2. **Unified Code**: The same function works both at compile-time and runtime without modification. In Rust, you often need separate `const fn` and non-const versions.

3. **First-Class Types**: Types are values in Yo, so type-level computation is natural function evaluation, not a separate type system feature.

4. **Seamless Fallback**: If compile-time evaluation isn't possible (e.g., runtime inputs), the same code runs at runtime.

## How It Works

### CTFE Context

During CTFE, Yo sets a special context flag (`forceCompileTimeBindings`) that:

1. Makes `:=` bindings store compile-time values (behaves like `::`)
2. Preserves function argument values for compile-time evaluation
3. Marks parameters as compile-time only

### Environment Propagation

When evaluating control flow (like `cond` or `match`) with compile-time known conditions, Yo:

1. Only evaluates the branch that will actually execute
2. Propagates the environment (including updated variable values) from that branch
3. Skips branches that are compile-time known to be unreachable

This allows mutable variables to be properly tracked through loops with `continue` and other control flow.

## Limitations

CTFE cannot be used when:

- Inputs are only known at runtime
- The function performs I/O operations
- The function uses async/await
- The function calls external C functions
- The function accesses mutable global state

## Best Practices

1. **Pure Functions**: Write pure functions (no side effects) for best CTFE results.

2. **Use `comptime_assert`**: Verify compile-time assumptions with `comptime_assert`.

3. **Leverage Type Parameters**: Use `comptime(T) : Type` for generic functions that need monomorphization.

4. **Trust the Compiler**: Don't over-annotate. Let Yo's automatic CTFE analysis do its job.

```rust
// Good: Clean, simple code that Yo can analyze
is_prime :: (fn(n : i32) -> bool) {
  cond(
    (n < 2) => false,
    true => {
      i := i32(2);
      result := true;
      while ((i * i) <= n), {
        cond(
          ((n % i) == 0) => {
            result = false;
            break;
          },
          true => ()
        );
        i = (i + 1);
      };
      result
    }
  )
};

// All evaluated at compile-time
comptime_assert(is_prime(2) == true);
comptime_assert(is_prime(17) == true);
comptime_assert(is_prime(18) == false);
```
