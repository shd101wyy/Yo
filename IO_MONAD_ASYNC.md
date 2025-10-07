# IO Monad for Asynchronous Operations

## Overview

Yo uses the **IO Monad** approach for asynchronous operations, inspired by Haskell, PureScript, and Koka. This design provides:

- **Type safety**: Async operations are explicitly typed with `IO(T)`
- **Simplicity**: No stack switching or state machine transformations needed
- **Composability**: Natural sequencing with `do` notation
- **Performance**: Zero-overhead callback-based implementation

## Core Concept

An `IO(T)` represents a computation that:
1. May perform side effects (I/O, async operations)
2. Eventually produces a value of type `T`
3. Is executed by the runtime, not immediately

```yo
// Synchronous function - pure
add :: (fn(a: i32, b: i32) -> i32) {
  a + b
}

// Asynchronous function - returns IO
fetch_data :: (fn(url: string) -> IO(string)) {
  IO.async(resume => {
    http_get_async(url, resume);  // Resume when data arrives
  });
}
```

## The IO Type

```yo
// IO monad represents an async/effectful computation
type IO(T) = /* internal: continuation-based */

// Core operations:
IO.pure    :: (fn(forall(T), value: T) -> IO(T))
IO.async   :: (fn(forall(T), f: fn(resume: fn(T) -> unit) -> unit) -> IO(T))
IO.bind    :: (fn(forall(A, B), io: IO(A), f: fn(A) -> IO(B)) -> IO(B))
IO.run     :: (fn(forall(T), io: IO(T)) -> T)
```

### IO.pure
Wraps a pure value in the IO monad (no async work).

```yo
IO.pure(42)  // IO(i32) containing 42
```

### IO.async
Creates an async operation. The function receives a `resume` callback to invoke when the result is ready.

```yo
IO.async(resume => {
  // Do async work...
  resume(result);  // Signal completion
})
```

**Important**: `resume` must be called exactly once with the result.

### IO.bind
Chains IO operations (used internally by `do` notation).

```yo
IO.bind(io, fn(result) {
  // Use result to produce next IO action
})
```

### IO.run
Executes an IO action (typically called by runtime at program entry).

```yo
main :: (fn() -> unit) {
  IO.run(my_async_program());
}
```

## Do Notation

The `do` notation provides clean syntax for sequencing IO operations.

### Syntax

```yo
do {
  x <- async_op1();      // Bind result of IO operation
  y <- async_op2(x);     // Use previous result
  pure(y + 1);           // Return final value
}
```

### Desugaring

The `do` notation desugars to nested `IO.bind` calls:

```yo
// This code:
do {
  x <- op1();
  y <- op2(x);
  pure(y);
}

// Becomes:
IO.bind(op1(), fn(x) {
  IO.bind(op2(x), fn(y) {
    IO.pure(y)
  })
})
```

### Pure Statements

Statements without `<-` are executed for side effects:

```yo
do {
  x <- get_input();
  printf("Got: %d\n", x);  // Side effect
  pure(x);
}

// Desugars to:
IO.bind(get_input(), fn(x) {
  printf("Got: %d\n", x);
  IO.pure(x)
})
```

## Channel Operations

Channels integrate naturally with IO monad.

### Channel Receive

```yo
chan_recv :: (fn(forall(T), ch: Chan(T)) -> IO(Option(T))) {
  IO.async(resume => {
    __yo_chan_recv_with_callback(ch, fn(result) {
      resume(result);
    });
  });
}

// Usage:
do {
  ch := chan(i32);
  value <- chan_recv(ch);
  match value {
    Some(x) => printf("Received: %d\n", x);
    None    => printf("Channel closed\n");
  };
  pure(unit);
}
```

### Channel Send

```yo
chan_send :: (fn(forall(T), ch: Chan(T), value: T) -> IO(unit)) {
  IO.async(resume => {
    __yo_chan_send_with_callback(ch, value, fn() {
      resume(unit);
    });
  });
}

// Usage:
do {
  ch := chan(i32);
  chan_send(ch, 42);
  pure(unit);
}
```

### Select Statement

```yo
select :: (fn(forall(T), cases: List(SelectCase(T))) -> IO(T)) {
  IO.async(resume => {
    __yo_select_with_callback(cases, resume);
  });
}

// Usage:
do {
  ch1 := chan(i32);
  ch2 := chan(string);
  
  result <- select([
    recv(ch1, fn(x) { printf("Got int: %d\n", x); }),
    recv(ch2, fn(s) { printf("Got string: %s\n", s); }),
  ]);
  
  pure(result);
}
```

## Spawning Tasks

Tasks that return IO actions can be spawned:

```yo
spawn :: (fn(forall(T), io: IO(T)) -> Task(T))

// Example:
worker :: (fn(id: i32) -> IO(unit)) {
  do {
    printf("Worker %d starting\n", id);
    sleep_ms(1000);
    printf("Worker %d done\n", id);
    pure(unit);
  }
}

main :: (fn() -> IO(unit)) {
  do {
    task1 := spawn(worker(1));
    task2 := spawn(worker(2));
    await(task1);
    await(task2);
    pure(unit);
  }
}
```

## Error Handling

Errors can be represented with `Result` type:

```yo
type Result(T, E) = Ok(T) | Err(E)

fetch_data :: (fn(url: string) -> IO(Result(string, HttpError))) {
  IO.async(resume => {
    http_get_async(url, fn(result) {
      match result {
        Success(data) => resume(Ok(data));
        Failure(err)  => resume(Err(err));
      }
    });
  });
}

// Usage with error handling:
do {
  result <- fetch_data("https://example.com");
  match result {
    Ok(data)  => printf("Success: %s\n", data);
    Err(err)  => printf("Error: %s\n", err.message);
  };
  pure(unit);
}
```

## Implementation Details

### Internal Representation

```yo
// IO is implemented as a continuation-based structure
type IO(T) = {
  run: fn(callback: fn(T) -> unit) -> unit
}

IO.pure :: (fn(forall(T), value: T) -> IO(T)) {
  { run: fn(callback) { callback(value); } }
}

IO.async :: (fn(forall(T), f: fn(resume: fn(T) -> unit) -> unit) -> IO(T)) {
  { run: fn(callback) { f(callback); } }
}

IO.bind :: (fn(forall(A, B), io: IO(A), f: fn(A) -> IO(B)) -> IO(B)) {
  { run: fn(callback) {
      io.run(fn(a) {
        f(a).run(callback);
      });
    }
  }
}
```

### C Code Generation

IO operations compile to callback-based C code:

```yo
// Yo code:
do {
  x <- async_read();
  printf("%d\n", x);
  pure(unit);
}

// Generated C (simplified):
void continuation_1(int32_t x) {
  printf("%d\n", x);
  // Resume next continuation...
}

void start() {
  async_read_with_callback(continuation_1);
}
```

### Task Scheduling

- `spawn(io)` creates a lightweight task that executes the IO action
- Tasks are scheduled on a work-stealing thread pool
- No stack allocation per task (callback-based)
- Tasks suspend/resume via continuation callbacks

## Advantages Over Other Approaches

### vs. Stackful Coroutines (setjmp/longjmp)
- ✅ No stack switching overhead
- ✅ No stack memory allocation
- ✅ Type safe
- ✅ Simpler runtime

### vs. Stackless State Machines (async/await)
- ✅ No complex state machine transformations
- ✅ No local variable extraction/storage
- ✅ Natural composition
- ✅ Simpler code generation

### vs. Raw Callbacks
- ✅ No callback hell (do-notation flattens)
- ✅ Type safe composition
- ✅ Easier error handling

## Examples

### HTTP Server

```yo
handle_request :: (fn(req: Request) -> IO(Response)) {
  do {
    user_id <- parse_user_id(req);
    user <- fetch_user(user_id);
    posts <- fetch_user_posts(user.id);
    pure(Response.json(posts));
  }
}

main :: (fn() -> IO(unit)) {
  do {
    server <- http_listen(8080);
    http_serve(server, handle_request);
    pure(unit);
  }
}
```

### Concurrent Workers

```yo
worker :: (fn(id: i32, ch: Chan(i32)) -> IO(unit)) {
  do {
    loop {
      msg <- chan_recv(ch);
      match msg {
        Some(n) => {
          printf("Worker %d processing %d\n", id, n);
          sleep_ms(100);
        };
        None => break;
      }
    };
    pure(unit);
  }
}

main :: (fn() -> IO(unit)) {
  do {
    ch := chan(i32);
    
    // Spawn workers
    spawn(worker(1, ch));
    spawn(worker(2, ch));
    
    // Send work
    for i in 0..10 {
      chan_send(ch, i);
    };
    
    // Close channel
    chan_close(ch);
    pure(unit);
  }
}
```

### File I/O Pipeline

```yo
process_file :: (fn(path: string) -> IO(Result(unit, Error))) {
  do {
    content <- read_file(path);
    lines := content.split("\n");
    processed := lines.map(process_line);
    write_file(path + ".out", processed.join("\n"));
    pure(Ok(unit));
  }
}

main :: (fn() -> IO(unit)) {
  do {
    files <- list_directory("./data");
    results <- files.map(process_file).parallel();
    results.iter(fn(result) {
      match result {
        Ok(_) => printf("Success\n");
        Err(e) => printf("Error: %s\n", e);
      }
    });
    pure(unit);
  }
}
```

## Comparison with Other Languages

### Haskell
```haskell
-- Haskell IO monad (inspiration)
main :: IO ()
main = do
  x <- getLine
  putStrLn x
```

### JavaScript/TypeScript
```typescript
// Promise-based (similar structure)
async function main() {
  const x = await readLine();
  console.log(x);
}
```

### Rust
```rust
// async/await (state machine based)
async fn main() {
  let x = read_line().await;
  println!("{}", x);
}
```

Yo's approach is closest to **Haskell's IO monad** but with:
- More concise syntax
- Built-in concurrency primitives (channels, spawn)
- Continuation-based runtime (no stack switching)

## Future Extensions

### Effect System
Could extend to general effect handlers:

```yo
type Effect(E, T) = ...

async :: Effect(Async, T)
state :: Effect(State(S), T)
except :: Effect(Exception(E), T)
```

### Parallel Execution
```yo
IO.par :: (fn(forall(T), ios: List(IO(T))) -> IO(List(T)))

do {
  results <- IO.par([fetch1(), fetch2(), fetch3()]);
  // All three run in parallel
  pure(results);
}
```

### Resource Management
```yo
IO.bracket :: (fn(forall(R, T), 
  acquire: IO(R),
  use: fn(R) -> IO(T),
  release: fn(R) -> IO(unit)
) -> IO(T))
```

## Summary

The IO Monad approach provides:
- ✅ **Simple implementation**: No state machines or stack management
- ✅ **Type safety**: Explicit async operations in type signatures
- ✅ **Performance**: Zero-overhead callback-based execution
- ✅ **Composability**: Natural sequencing with do-notation
- ✅ **Proven design**: Battle-tested in Haskell and other languages

This eliminates the need for complex stackful or stackless coroutine implementations while providing excellent ergonomics and safety.
