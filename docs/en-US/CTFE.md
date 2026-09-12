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

### Reading a file at compile time: `comptime_read_file`

`comptime_read_file(path)` reads a file while the program is being compiled and
yields its bytes as a `comptime_str` — Zig's `@embedFile`:

```rust
VERSION :: comptime_read_file("./VERSION");
SHADER  :: comptime_read_file("./shaders/blit.wgsl");

comptime_assert(VERSION == "0.4.1\n");   // checked at compile time
```

Two rules keep it predictable:

1. **The path is relative to the importing file**, never to the process working
   directory. A module reads the same bytes no matter where `yo build` was run
   from.
2. **It must resolve inside that file's package root** — the directory of the
   nearest `yo.toml` above it, else the nearest directory holding a `build.yo`,
   else the file's own directory. Reading outside is a compile error, and the
   check is on the lexically folded path, so `..` cannot climb out and back in.

A missing file is a compile error too, reported at the call site.

The file is an **input** of the compile: `yo compile --emit-deps` lists it, and
`yo build` re-runs the artifact when it changes (see "Incremental builds" in the
build system documentation). Editing an embedded data file invalidates the
cache exactly like editing a `.yo` source.

Byte content is fine: the value is a byte string, so a file with quotes,
newlines or non-UTF-8 bytes travels verbatim.

### Parsing data at compile time: `comptime_json_parse` / `comptime_toml_parse`

Both take a compile-time string and return a `ComptimeValue` — a document tree
made of compile-time scalars and `ComptimeList`, since no runtime container can
exist at compile time. Composed with `comptime_read_file`, a configuration file
becomes constants:

```rust
CFG :: comptime_json_parse(comptime_read_file("./config.json"));

PORT :: CFG.get("port").as_int(8080);
NAME :: CFG.get("name").as_str("unnamed");

comptime_assert(PORT == 8080);        // a wrong parse fails to COMPILE
```

`ComptimeValue` is an enum — `Null`, `Bool`, `Int`, `Float`, `Str`, `List`, and
`Table` — so it can be matched directly, and it carries helpers for the common
reads:

| | |
| --- | --- |
| `get(key)` | the value under `key` of a table; `.Null` if absent or not a table |
| `at(i)` | the element at `i` of a list; `.Null` if out of range or not a list |
| `len()` | elements of a list, or entries of a table; `0` otherwise |
| `as_str(fallback)` / `as_int(fallback)` / `as_bool(fallback)` | the scalar, or the fallback if it holds something else |
| `is_null()` | true for a missing key and for an explicit JSON `null` alike |

A table keeps parallel `keys` and `values` lists in document order, the same
shape `std/encoding/json`'s `JsonValue.Object` uses.

Two details worth knowing:

- **JSON has one number type.** A whole-valued number becomes `Int`, so
  `{"port": 8080}` reads back as an integer rather than as `8080.0`. The cut is
  on the value, not the spelling.
- **A malformed document is a compile error** at the call site, carrying the
  parser's own position — not a runtime failure.

The parsers are the ones in `std/encoding/json` and `std/encoding/toml`, run at
the compiler's own runtime; there is no second implementation to keep in step.

Yo data needs no parser at all: `import("./data.yo")` of a file holding one `::`
binding already yields the value at compile time.

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
