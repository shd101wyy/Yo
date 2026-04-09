# Yo Async and Effects Recipes

These patterns cover normal Yo async code and algebraic effects.

## Pick the right execution model

| Need                       | Pattern                                                   |
| -------------------------- | --------------------------------------------------------- |
| Sequential async work      | `result := io.await(task)`                                |
| Start work and wait later  | `handle := io.spawn(task)` then `handle.await(using(io))` |
| Yield to other ready tasks | `io.await(yield())`                                       |
| True multithreading        | Use thread or parallelism APIs, not `io.async` alone      |

## Minimal async function

```rust
{ yield } :: import "std/async";

pause_then_answer :: (fn(using(io : IO)) -> Impl(Future(i32, IO)))(
  io.async((using(io : IO)) => {
    io.await(yield());
    i32(42)
  })
);
```

- `io.async(...)` is lazy
- If a function uses `using(io : IO)` and returns a future, include `IO` in the `Future(...)` type

## Sequential await

```rust
{ yield } :: import "std/async";

main :: (fn(using(io : IO)) -> unit)({
  task := io.async((using(io : IO)) => {
    io.await(yield());
    i32(1)
  });

  result := io.await(task);
  assert((result == i32(1)), "unexpected result");
});

export main;
```

## Concurrent tasks on the same thread

```rust
{ yield } :: import "std/async";

main :: (fn(using(io : IO)) -> unit)({
  task1 := io.async((using(io : IO)) => {
    io.await(yield());
    i32(1)
  });
  task2 := io.async((using(io : IO)) => {
    io.await(yield());
    i32(2)
  });

  handle1 := io.spawn(task1);
  handle2 := io.spawn(task2);

  result1 := handle1.await(using(io));
  result2 := handle2.await(using(io));
});

export main;
```

- `io.spawn(...)` begins execution without waiting
- `handle.await(using(io))` returns `Option(T)` because a spawned task can abort via `escape`

## Propagating and handling effects

```rust
open import "std/fmt";
open import "std/string";

Raise :: (fn(msg : String) -> i32);

safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(
  cond(
    (y == i32(0)) => raise(`divide by zero`),
    true => (x / y)
  )
);

resume_example :: (fn() -> i32)({
  (given(raise) : Raise) = (fn(msg : String) -> i32)({
    println(msg);
    return i32(0);
  });

  safe_divide(i32(8), i32(0))
});

escape_example :: (fn() -> i32)({
  (given(raise) : Raise) = (fn(msg : String) -> i32)({
    println(msg);
    escape i32(-1);
  });

  safe_divide(i32(8), i32(0))
});
```

| Handler action | Meaning                                      |
| -------------- | -------------------------------------------- |
| `return value` | Resume the continuation with `value`         |
| `escape expr`  | Exit the function that installed the handler |

## Futures with multiple effects

```rust
{ yield } :: import "std/async";

work :: (fn(using(io : IO, raise : Raise)) -> Impl(Future(i32, IO, Raise)))(
  io.async((using(io : IO, raise : Raise)) => {
    io.await(yield());
    safe_divide(i32(10), i32(2), using(raise))
  })
);
```

- Every effect used by the future should appear in the `Future(...)` type
- Effects propagate through `using(...)` just like other contextual parameters

## Common pitfalls

- `io.async(...)` does not run immediately
- `escape` inside async aborts the future instead of completing it normally
- `io.await(...)` on an aborted future can panic; `JoinHandle.await(...)` converts abort into `.None`
- Handler functions cannot capture outer variables like closures; pass required state explicitly

## Exception (non-resumable)

`Exception` is a built-in module effect for non-resumable error handling. When the handler calls `escape`, the continuation is discarded:

```rust
open import "std/error";
open import "std/fmt";

DivError :: enum(DivByZero);
impl(DivError, ToString(to_string : ((self) -> `division by zero`)));
impl(DivError, Error());

safe_divide :: (fn(x : i32, y : i32, using(exn : Exception)) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(DivError.DivByZero)),
    true => (x / y)
  )
);

main :: (fn() -> unit)({
  given(exn) := Exception(
    throw : ((err) -> {
      println(`Error: ${err}`);
      escape ();
    })
  );

  result := safe_divide(i32(10), i32(2));
  println(`result: ${result}`);

  safe_divide(i32(10), i32(0));
});

export main;
```

- `Exception` has a single field `throw : (fn(error : AnyError) -> T)`
- `exn.throw(dyn(error))` calls the handler with a type-erased error
- Handler uses `escape` to discard the continuation and exit the enclosing function
- Code after the escaped call is never reached

## ResumableException

`ResumableException(ResumeType)` is a module effect for resumable error handling. The handler uses `return` to resume with a recovery value:

```rust
open import "std/error";
open import "std/fmt";

safe_divide :: (fn(x : i32, y : i32, using(exn : ResumableException(i32))) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(`division by zero`)),
    true => (x / y)
  )
);

main :: (fn() -> unit)({
  given(exn) := ResumableException(i32)(
    throw : ((err) -> {
      println(`Recovering from: ${err}`);
      return i32(0);
    })
  );

  result := safe_divide(i32(10), i32(0));
  assert((result == i32(0)), "recovered with 0");
});

export main;
```

- Handler uses `return value` to resume the continuation with the recovery value
- The call site receives the returned value and continues normally

## Module effects vs function-type effects

Effects in Yo can be plain function types or module types:

```rust
Raise :: (fn(msg : String) -> i32);

Logger :: module(
  log : (fn(level : i32, msg : String) -> unit)
);
```

Both kinds use `using(...)` / `given(...)` with the same semantics — they compile to evidence passing (function pointers as implicit C parameters). Module effects group related operations under a single name.

## Async with effects

When an async future uses effects, include them in the `Future` type:

```rust
work :: (fn(using(io : IO, exn : Exception)) -> Impl(Future(i32, IO, Exception)))(
  io.async((using(io : IO, exn : Exception)) => {
    io.await(yield());
    safe_divide(i32(10), i32(2), using(exn))
  })
);
```

To spawn a task with effects, pass them explicitly via `using`:

```rust
handle := io.spawn(task, using(io, exn));
result := handle.await(using(io));
match(result,
  .Some(value) => println(`got: ${value}`),
  .None => println("task aborted via escape")
);
```

## Effect row variables (advanced)

Functions can be polymorphic over their effects using spread parameters:

```rust
wrapper :: (fn(forall(...(E)), x : i32, using(...(E))) -> i32)(
  safe_divide(x, i32(2))
);
```

- `forall(...(E))` introduces an effect row variable
- `using(...(E))` forwards whatever effects the caller provides
- See [ALGEBRAIC_EFFECTS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/ALGEBRAIC_EFFECTS.md) for the full design
