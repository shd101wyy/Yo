# Testing

Writing and running tests: `test(...)`, assertions, expected compile errors,
test files, and testing `Drop`. `yo test --help` lists the runner's flags.

## Overview

Yo has a built-in testing framework accessible via the `test` keyword.

## Basic Test Syntax

```yo
test("Test description", {
  // Test code here
  x := (1 + 1);
  assert(x == 2, "x should be 2");
});

// Io is implicitly available via `io` in all test bodies
test("With effects", {
  io.await(sleep(u64(1000)), io);
});
```

## Running Tests

Tests can be run using the Yo CLI:

```bash
# Run all tests in a file
$ yo test path/to/file.test.yo

# Run specific test by pattern
$ yo test path/to/file.test.yo --test-name-pattern "Test addition"

# Stop on first failure
$ yo test path/to/file.test.yo --bail

# Verbose output
$ yo test path/to/file.test.yo -v

# List the tests a path + pattern selects, without compiling anything
$ yo test ./tests --list

# One JSON object per line: a "test" event per test (file, name, status,
# duration_ms; message and captured output on failure), then a "summary" event
$ yo test ./tests --json
```

## Assertions

### Runtime Assertions

```yo
{ assert } :: import("std/assert");

test("Runtime assertions", {
  x := 42;

  // Basic assertion
  assert(x == 42);

  // Assertion with message
  assert(x > 0, "x should be positive");

  // Complex assertions
  arr := [1, 2, 3];
  assert(arr.len() == 3, "Array should have 3 elements");
});
```

### Compile-Time Assertions

Use `comptime_assert` for compile-time verification:

```yo
test("Compile-time assertions", {
  // These are checked during compilation
  comptime_assert((2 + 2) == 4);
  comptime_assert(Array(i32, 5).fill(0).len() == 5);
  comptime_assert(f32(3.14) > f32(3.0));

  // Type-level assertions
  T :: i32;
  comptime_assert(Type.to_comptime_string(T) == "i32");
});
```

## Testing Expected Errors

Verify that certain code produces compile-time errors:

```yo
test("Expected compile errors", {
  // Expect an error without specific message
  comptime_expect_error({
    x :: (1 / 0); // Division by zero
  });

  // Expect an error with specific message
  comptime_expect_error({
    arr : Array(i32, _);
    arr = [1, 2, 3];
  }, "Array type with inferred length '_' is not allowed in type annotations");

  // Test that certain patterns are invalid
  comptime_expect_error({
    closure1 := (x => (x + 1));
    closure2 := (x => (x + 1));
    // Each closure has unique type
    (c : type_of(closure1)) = closure2; // Error!
  }, "no two closures have the same type");
});
```

## Test Organization

Organize related tests in the same file:

```yo
// arithmetic.test.yo
test("Addition", {
  assert((1 + 1) == 2);
  assert((5 + 3) == 8);
});

test("Subtraction", {
  assert((5 - 3) == 2);
  assert((10 - 10) == 0);
});

test("Multiplication", {
  assert((2 * 3) == 6);
  assert((7 * 0) == 0);
});

test("Division", {
  assert((10 / 2) == 5);
  assert((9 / 3) == 3);
});
```

## Testing Drop

Test cleanup and disposal:

```yo
{ println } :: import("std/fmt");
{ assert } :: import("std/assert");

MyBox :: struct(value : i32);
impl(
  MyBox,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      println(`Disposing MyBox with value: ${self.value}`);
    })
  )
);

test("Object disposal", {
  // MyBox is automatically dropped at end of scope
  mut(b) := MyBox(value : 42);
  assert(b.value == 42);
  b.value = 100;
  assert(b.value == 100);
  // drop runs automatically here; calling it by hand is E0915
});
```

## Test Files

Yo test files typically use the `.test.yo` extension:

- `basic.test.yo` - Basic language features
- `array.test.yo` - Array operations
- `closure.test.yo` - Closure functionality
- `async-await.test.yo` - Async/await features
- `collections/*.test.yo` - Collection types

For comprehensive test examples, see the `tests/` directory.
