# Async/Await - Single-Threaded Concurrency for Yo

## Philosophy

Yo uses **async/await with state machine transformation** for efficient **single-threaded concurrency**. This is a stackless coroutine model similar to JavaScript's event loop - all async code runs on the **same thread** as the caller.

**Key Insight**: `async/await` provides **concurrency** (interleaved execution), not **parallelism** (simultaneous execution). For parallelism, see `PARALLELISM.md` which describes the `spawn` API for isolated multi-threaded execution.

```yo
// All async code runs on the SAME thread
main :: (fn() -> unit) {
  // Start the async event loop on the main thread
  async {
    task1 := fetch("http://example.com");  // Returns immediately
    task2 := fetch("http://rust-lang.org"); // Returns immediately
    // Both tasks interleave on THIS thread
    result1 := await task1;  // Suspend until ready
    result2 := await task2;  // Suspend until ready
  };
};
```

## Concurrency vs Parallelism

| Concept         | Mechanism     | Description                                |
| --------------- | ------------- | ------------------------------------------ |
| **Concurrency** | `async/await` | Multiple tasks interleaved on ONE thread   |
| **Parallelism** | `spawn`       | Multiple tasks running on SEPARATE threads |

```yo
// Concurrency: Same thread, interleaved execution
async {
  a := fetch(url1);  // Start fetch
  b := fetch(url2);  // Start fetch (same thread!)
  await a;           // Yield until a ready
  await b;           // Yield until b ready
};

// Parallelism: Different threads, true simultaneous execution
task := Task(i32, boolean).spawn((parent) -> {
  // Runs on a DIFFERENT thread!
  // Completely isolated - no shared memory
});
```

## Execution Model: Eager Start

Yo's async functions use **eager execution** (like C# and C++):

- Async functions start executing **immediately** when called
- Execution continues until the **first `await`** point
- If there's no `await`, the function runs to completion synchronously
- This makes side effects predictable and errors immediate

```yo
fetch :: (fn(url: String) -> Impl Future(String)) async {
  println("Starting fetch");  // Prints IMMEDIATELY when called
  validate_url(url);          // Runs synchronously - errors throw now!
  response := await http_get(url);  // First await - suspends here
  return response;
};

// Calling an async function:
future := fetch("http://example.com");  // "Starting fetch" prints NOW
                                        // Runs until first await
// ... do other work ...
result := await future;  // Resume and wait for completion
```

**Key Difference from Lazy Models (Rust, Haskell):**

- Lazy: `let f = async_fn()` does nothing until awaited
- Eager: `f := async_fn()` runs immediately until first `await`

## Motivation

### Why Single-Threaded Async?

1. **Simplicity**: No thread safety concerns, no Send trait needed for async
2. **No data races**: All async code runs on one thread
3. **Memory Efficiency**: State machines only need ~100-500 bytes per task
4. **Massive Concurrency**: Can handle millions of concurrent tasks
5. **Zero-Cost Abstraction**: State machine transformation at compile time
6. **Familiar Model**: Same as C#, C++, JavaScript - proven and intuitive
7. **No Atomics Needed**: Reference counting doesn't need atomic operations
8. **Eager Execution**: Predictable side effects and immediate error detection

### Why Not Multi-Threaded Async?

Multi-threaded async (like Rust's tokio) adds complexity:

- Need `Send` trait to verify thread safety
- Need atomic reference counting
- Need cross-thread synchronization
- Work-stealing adds overhead

Yo's approach: Keep async simple (single-threaded), use `spawn` for parallelism (isolated threads).

## Language Syntax

```yo
// Async function
fetch_data :: (fn(url: String) -> Impl Future(Data)) async {
  response := await http_get(url);
  data := await response.read();
  return data;
};

// Calling async from another async function
process :: (fn() -> Impl Future(unit)) async {
  data := await fetch_data("http://example.com");
  println(data);
};

// Main entry point - async block starts event loop
main :: (fn() -> unit) {
  async {
    // fetch starts executing IMMEDIATELY (eager)
    future := fetch("http://example.com");
    // ... future is already running until first await ...
    result := await future;
    println(result);
  };
};

// Async blocks - also eager execution
compute :: (fn() -> Impl Future(i32)) {
  return async {
    // This code runs IMMEDIATELY when compute() is called
    println("Starting computation");
    x := await fetch_data("http://example.com");  // First await - suspends
    y := await process_data(x);
    return y;
  };
};
```

### Keywords

```yo
async { ... }    // Async block expression (returns Future, runs on same thread)
await expr       // Suspend until Future ready (only in async context)
```

**Important Rules**:

1. Async functions execute **eagerly** - they start running immediately when called
2. Execution continues until the **first `await`** or completion (if no await)
3. Async blocks `async { ... }` return `Impl Future(T)` where T is the block's result type
4. `await` can **only** be used inside async functions or `async { ... }` blocks
5. All async code runs on the **same thread** - no thread spawning
6. `await` suspends the current coroutine and yields to other ready tasks

### Execution Model

```yo
// All three tasks run on the SAME thread
async {
  // EAGER execution - each task runs immediately until first await!
  t1 := task1();  // Runs NOW until first await, returns suspended Future
  t2 := task2();  // Runs NOW until first await, returns suspended Future
  t3 := task3();  // Runs NOW until first await, returns suspended Future

  // Interleaved execution:
  // - t1 ran until its first await, now suspended
  // - t2 ran until its first await, now suspended
  // - t3 ran until its first await, now suspended
  // - When t1's IO completes, resumes t1
  // - etc.

  await t1;  // Wait for t1 to complete
  await t2;  // Wait for t2 to complete
  await t3;  // Wait for t3 to complete
};
```

### Future Type

```yo
// Built-in Future type (compiler-generated state machine)
// Current implementation detail:
// - `Impl(Future(T))` is represented as a pointer to a heap-allocated state machine.
// - The state machine stores:
//   - state: int (0..N, -1 = completed)
//   - continuation_fn / continuation_sm (who to resume on completion)
//   - result: T (when completed; omitted for unit)
//   - captured vars + locals that cross await
// - Dropping/disposing the Future frees the state machine.

// Async function signature
fetch :: (fn(url: String) -> Impl Future(String));
```

Why heap allocation?

- A Future can suspend at an `await` and resume later; the state machine must have a stable address after the current C stack frame returns.
- The runtime queues continuations as `(resume_fn, state_machine_ptr)`, so the state machine must outlive the scheduling point.

This is an implementation choice, not a semantic requirement; alternate designs exist (see `ASYNC_AWAIT_MIGRATION.md`).

## State Machine Transformation

The compiler transforms async functions into state machines at each `await` point.

### Example Transformation

**Input Yo code:**

```yo
fetch_data :: (fn(url: String) -> Impl Future(Data)) async {
  response := await http_get(url);
  data := await response.read();
  return data;
};
```

**Conceptual transformation:**

1. **State Machine Struct**:

   - Tracks current state (0, 1, 2...)
   - Captures function parameters (url)
   - Stores local variables used across await points (response, data)
   - Holds pending futures

2. **Poll Function**:

   - Switch statement with one case per state
   - State 0: Call http_get, check if ready
   - State 1: Extract response result, call read, check if ready
   - State 2: Extract data result, return Ready(data)

3. **Async Function Entry (Eager Execution)**:
   - Runs synchronously until first `await` point
   - At first `await`: allocates state machine on heap
   - Creates Future pointing to state machine
   - Returns suspended Future (does NOT block on IO)

### Key Points

- Each `await` becomes a state transition
- Local variables used across `await` are captured in state struct
- Poll function is a switch statement advancing through states
- No threads involved - all polling happens on same thread

## Event Loop

The async runtime uses a simple **single-threaded event loop**:

```
┌─────────────────────────────────────────────┐
│              Event Loop (Main Thread)       │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │           Ready Queue               │    │
│  │  ┌─────┐ ┌─────┐ ┌─────┐           │    │
│  │  │Task1│ │Task2│ │Task3│  ...      │    │
│  │  └─────┘ └─────┘ └─────┘           │    │
│  └─────────────────────────────────────┘    │
│                    │                        │
│                    ▼                        │
│  ┌─────────────────────────────────────┐    │
│  │         Poll next ready task        │    │
│  │   - Run until await                 │    │
│  │   - If IO pending, register waker   │    │
│  │   - If ready, continue              │    │
│  └─────────────────────────────────────┘    │
│                    │                        │
│                    ▼                        │
│  ┌─────────────────────────────────────┐    │
│  │         IO Completion Check         │    │
│  │   - Check epoll/kqueue/IOCP         │    │
│  │   - Wake completed tasks            │    │
│  │   - Add to ready queue              │    │
│  └─────────────────────────────────────┘    │
│                                             │
└─────────────────────────────────────────────┘
```

### Event Loop Steps

1. **Dequeue** a ready task from the ready queue
2. **Poll** the task's state machine
3. **If await on pending IO**: Register waker, task sleeps
4. **If await on ready Future**: Continue to next state
5. **If complete**: Mark Future as ready, wake awaiters
6. **Check IO**: Poll OS for completed IO events
7. **Wake tasks**: Move woken tasks to ready queue
8. **Repeat** until all tasks complete

## Memory Management

### Non-Atomic Reference Counting

Since all async code runs on one thread:

- No atomic operations needed for RC
- Simple increment/decrement
- No synchronization overhead

```c
// Non-atomic RC (single-threaded)
struct yo_ref_header {
  size_t ref_count;  // Simple size_t, not atomic!
};

// Increment - no atomics!
static inline void yo_rc_inc(yo_ref_header_t* header) {
  header->ref_count++;
}

// Decrement - no atomics!
static inline bool yo_rc_dec(yo_ref_header_t* header) {
  return --header->ref_count == 0;
}
```

### Future Lifetime Management

Futures (async block state machines) are **reference counted** to handle cases where tasks complete before being awaited:

**Lifetime Pattern: "Event Loop Holds References"**

```yo
main :: (fn() -> unit) {
  task := async { /* work */ };  // Creates Future with refcount=2
  // User reference (task) + Running task reference (event loop)
  
  // task goes out of scope - refcount decrements to 1
  // Task continues running! Event loop still holds reference
};
// After main, __yo_async_wait_all() processes remaining tasks
// Task completes, decrements refcount to 0, frees memory
```

**Refcount Lifecycle:**

1. **Creation**: Constructor initializes `refcount = 1`
2. **Eager Start**: `__yo_incr_rc()` before spawning (refcount = 2)
   - One reference for user code (the `task` variable)
   - One reference for the running task (held by event loop)
3. **User Drop**: When `task` goes out of scope, `__yo_decr_rc()` (refcount = 1)
4. **Task Completion**: State machine calls `__yo_decr_rc()` (refcount = 0, freed)

**Key Insight**: Tasks stay alive until completion even if user code drops them early!

**Implementation Details:**

The state machine struct includes a `yo_ref_header_t` as its first field:

```c
struct async_block_state_t {
  yo_ref_header_t header;  // Must be first for __yo_decr_rc to work
  _Atomic int state;
  // ... other fields ...
};
```

The `Impl(Future(T))` type uses `__yo_sometype_drop` which calls `__yo_decr_rc`:

```c
void fn_id12345___drop(async_block_state_t* self) {
  if (self != NULL) { __yo_decr_rc((void*)self); };
}
```

**Type System Integration:**

The evaluator's `getMethodsByNameFromEnv` function has special handling for Future types - it does NOT use the `resolvedConcreteType` for method lookup. This ensures that when calling `task.___drop()`, it uses the SomeType's own `___drop` method which calls `__yo_sometype_drop`, rather than using the capture struct's drop function.

### State Machine Lifecycle

```c
// 1. Creation - allocate Future with state machine
FunctionName_Future* future = __yo_malloc(sizeof(FunctionName_Future));
future->header.ref_count = 1;  // Initial refcount
future->state = PENDING;
// Initialize state machine fields...

// 2. Eager Execution - increment refcount and spawn
__yo_incr_rc(future);  // refcount = 2
yo_async_spawn_task(resume_fn, future);
// Runs immediately until first await

// 3. Polling - event loop polls repeatedly until complete
while (poll(future) == PENDING) {
  yield_to_event_loop();
}

// 4. Completion
future->state = READY;
future->result = final_value;
__yo_decr_rc(future);  // Release running task reference
// Wake awaiters

// 5. Cleanup - when user drops, refcount reaches 0, freed
```

### State Machine Memory

State machines are small (~32-500 bytes):

- State ID: 4 bytes
- Captured parameters: varies
- Captured locals: varies
- Pending Futures: 8 bytes each

## Performance Characteristics

### Memory Usage

**10,000 concurrent async operations:**

- State machines: 10,000 × ~200 bytes = 2MB
- No thread stacks needed!

**Comparison:**

- 10,000 OS threads × 1MB stack = 10GB ❌
- 10,000 Go goroutines × 2KB = 20MB
- 10,000 Yo async tasks × 200 bytes = 2MB ✅

### Throughput

- State machine poll: ~10-50ns per poll
- No context switching (same thread)
- No synchronization overhead
- Cache-friendly (small state machines)

## API

### Async Runtime

```yo
// Start the async event loop (blocks until all tasks complete)
async { ... }

// Define async function
name :: (fn(...) -> Impl Future(T)) async { ... };

// Await a future (only in async context)
result := await future;
```

### Example: Complete Async Program

```yo
// Async function
fetch :: (fn(url: String) -> Impl Future(String)) async {
  response := await http_get(url);
  body := await response.read_body();
  return body;
};

// Async function with multiple awaits
fetch_both :: (fn(url1: String, url2: String) -> Impl Future(String)) async {
  // EAGER: Each fetch() runs immediately until its first await!
  f1 := fetch(url1);  // Executes fetch synchronously until await http_get
  f2 := fetch(url2);  // Executes fetch synchronously until await http_get

  // Both are now suspended waiting for IO
  // Await results (interleaved on same thread)
  r1 := await f1;
  r2 := await f2;

  return r1 ++ r2;
};

// Main entry point
main :: (fn() -> unit) {
  async {
    result := await fetch_both("http://a.com", "http://b.com");
    println(result);
  };
};
```

## Comparison with Other Languages

| Language                            | Model                    | Threading           | Memory/Task | Max Concurrency |
| ----------------------------------- | ------------------------ | ------------------- | ----------- | --------------- |
| **Yo**                              | Stackless state machines | **Single-threaded** | ~200 bytes  | Millions        |
| **JavaScript**                      | Stackless promises       | **Single-threaded** | ~100 bytes  | Millions        |
| **Python (asyncio)**                | Stackless coroutines     | **Single-threaded** | ~200 bytes  | Millions        |
| **Rust (single-threaded executor)** | Stackless futures        | **Single-threaded** | ~100 bytes  | Millions        |
| **Rust (tokio multi-threaded)**     | Stackless futures        | Multi-threaded      | ~100 bytes  | Millions        |
| **Go**                              | Stackful goroutines      | Multi-threaded      | 2KB+        | 100K-1M         |

**Note**: Yo's single-threaded async is most similar to JavaScript and Python asyncio:

- ✅ Simple mental model (no thread safety)
- ✅ No Send/Sync traits needed
- ✅ No atomic RC overhead
- ✅ Familiar to web developers

For parallelism, use `spawn` (see `PARALLELISM.md`).

## Summary

Yo's async/await provides:

1. ✅ **Eager execution** - async functions run immediately until first `await` (like C#/C++)
2. ✅ **Single-threaded concurrency** - all async runs on one thread
3. ✅ **No thread safety concerns** - no data races possible
4. ✅ **Familiar syntax** - like C#, C++, JavaScript, Python
5. ✅ **State machine transformation** - zero-cost abstraction
6. ✅ **Non-atomic RC** - no synchronization overhead
7. ✅ **Memory efficient** - millions of concurrent tasks (~200 bytes each)
8. ✅ **Simple mental model** - no Send trait, no work stealing
9. ✅ **Predictable side effects** - setup code runs immediately
10. ✅ **Zero-cost** - compiled to efficient C code

### Quick Reference

```yo
// Define async function
fetch :: (fn(url: String) -> Impl Future(Data)) async {
  response := await http_get(url);
  data := await response.read();
  return data;
};

// Start async event loop
main :: (fn() -> unit) {
  async {
    data := await fetch("http://example.com");
    println(data);
  };
};

// Multiple concurrent tasks (same thread!)
async {
  task1 := fetch(url1);  // Runs eagerly until first await
  task2 := fetch(url2);  // Runs eagerly until first await
  result1 := await task1;  // Wait for completion
  result2 := await task2;  // Wait for completion
};

// Async blocks
compute :: (fn() -> Impl Future(i32)) {
  return async {
    x := await get_value();
    y := await process(x);
    return x + y;
  };
};
```

### Key Principles

1. **Eager execution** - async functions run immediately until first `await`
2. **`async { ... }` blocks** - start event loop, return `Impl Future(T)`
3. **Single-threaded** - all async code runs on the calling thread
4. **`await` yields** - suspends coroutine, yields to other ready tasks
5. **State machines** - compiler transforms each `await` into state transition
6. **No thread safety** - no Send trait, no atomics, no data races
7. **Non-atomic RC** - simple reference counting (no synchronization)
8. **Event loop** - polls ready tasks, checks IO completion
9. **Zero-cost** - compiled to efficient C code

### When to Use What

| Use Case                       | Mechanism                    |
| ------------------------------ | ---------------------------- |
| IO-bound concurrent tasks      | `async/await`                |
| CPU-bound parallel computation | `spawn` (see PARALLELISM.md) |
| Background processing          | `spawn` (see PARALLELISM.md) |
| Waiting for multiple IOs       | `async/await`                |
| Utilizing multiple CPU cores   | `spawn` (see PARALLELISM.md) |
