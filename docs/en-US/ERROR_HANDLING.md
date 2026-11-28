# Error Handling

How a Yo program reports and handles failure: `Result` values, the `Error`
trait and `AnyError`, and the `Exception` and `ResumableException` handlers.
Handlers in general are in [ALGEBRAIC_EFFECTS.md](./ALGEBRAIC_EFFECTS.md); the
runtime aborts (overflow, out-of-bounds) are in
[SYNTAX.md](./SYNTAX.md#arithmetic-and-failure-semantics).

## Overview

Yo provides two approaches to error handling:

1. **Result ADT** — explicit `Result(T, E)` values with pattern matching
2. **Exception / ResumableException** — handlers passed as parameters, for exception-like control flow

## Result Type

The `Result` type is an algebraic data type for functions that can fail:

```yo
// Define an error type
DivisionError :: enum(
  DivideByZero,
  Overflow
);

// Function that can fail
safe_div :: (fn(a : i32, b : i32) -> Result(i32, DivisionError))(
  cond(
    (b == i32(0)) => .Error(.DivideByZero),
    true => .Ok(a / b)
  )
);

// Handle errors with pattern matching
result := safe_div(10, 2);
match(
  result,
  .Ok(value) => printf("Result: %d\n", value),
  .Error(error) => match(
    error,
    .DivideByZero => printf("Error: Cannot divide by zero\n"),
    .Overflow => printf("Error: Overflow\n")
  )
);
```

## Error Trait and AnyError

The standard library defines an `Error` trait and `AnyError` type for dynamic error handling:

```yo
{ Error, AnyError } :: import("std/error");

// Error trait requires ToString. `derive(Error)` supplies both from one
// message per variant, listed in declaration order:
MathError :: enum(
  DivisionByZero,
  NegativeSqrt
);
derive(
  MathError,
  Error(
    .DivisionByZero => `Division by zero`,
    .NegativeSqrt => `Square root of a negative number`
  )
);
// An AnyError's payload is Clone (see below):
derive(MathError, Clone);

// The message is ordinary Yo, spliced into the arm that binds the payload, so
// a variant's own fields interpolate by name:
//   .NotFound(path : String)  =>  `not found: ${path}`
// Writing the two impls by hand still works, and is the way to go when the
// message is not a simple per-variant string.
// AnyError is Box(Dyn(Error, Clone)) — any type implementing Error and
// Clone can be wrapped with dyn(Box.new(e)). It owns its payload
// uniquely, and `throw` passes the error by value, so a handler keeps a caught
// error by moving it.
(err : AnyError) = dyn(Box.new(MathError.DivisionByZero));

// Downcast back to the concrete type, borrowing it:
match(
  downcast(&err.*, MathError),
  .Some(math_err) => printf("Got MathError\n"),
  .None => printf("Not a MathError\n")
);
```

## Exception (Non-Resumable)

`Exception` is an effect bundle for non-resumable exception handling.
Its `throw` field is a `ctl(...) -> ret` handler — calling
`unwind(...)` inside its body discards the continuation and returns
from the enclosing function:

```yo
{ Exception } :: import("std/error");

safe_divide :: (fn(x : i32, y : i32, exn : Exception) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(Box.new(MathError.DivisionByZero))),
    true => (x / y)
  )
);

// Install the handler — note the outer parens around the lambda
// (Yo has no operator precedence).
(exn : Exception) = Exception(
  throw : (
    err -> {
      println(`Error: ${err}`); // prints "Error: Division by zero"
      unwind(()); // discard continuation, return from enclosing fn
    }
  )
);

result := safe_divide(6, 3, exn); // result = 2
safe_divide(10, 0, exn); // handler fires, unwinds — code after this is unreached
```

An `Exception` handler cannot resume the throw with a value. `throw`'s
resume type is a type variable that each throw site picks, so a handler
must `unwind`, diverge, or fall through with `()`. A handler that
returns a value of a fixed type, such as `err -> { return(i32(7)); }`,
is a compile error that points at `ResumableException`:

## ResumableException

`ResumableException(ResumeType)` is for resumable exception handling.
When the handler calls `return`, it resumes the continuation with a
recovery value:

```yo
{ ResumableException } :: import("std/error");

safe_divide :: (fn(x : i32, y : i32, exn : ResumableException(i32)) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(Box.new(`division by zero`))),
    true => (x / y)
  )
);

(exn : ResumableException(i32)) = ResumableException(i32)(
  throw : (
    err -> {
      println(`Error: ${err}`);
      return(i32(0)); // resume with recovery value 0
    }
  )
);

result := safe_divide(6, 3, exn); // result = 2
result2 := safe_divide(10, 0, exn); // handler resumes with 0, result2 = 0
```

For more examples, see `tests/error.test.yo`.
