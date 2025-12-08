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

| Concept | Mechanism | Description |
|---------|-----------|-------------|
| **Concurrency** | `async/await` | Multiple tasks interleaved on ONE thread |
| **Parallelism** | `spawn` | Multiple tasks running on SEPARATE threads |

```yo
// Concurrency: Same thread, interleaved execution
async {
  a := fetch(url1);  // Start fetch
  b := fetch(url2);  // Start fetch (same thread!)
  await a;           // Yield until a ready
  await b;           // Yield until b ready
};

// Parallelism: Different threads, true simultaneous execution
task := Task(i32, boolean).spawn(fn(parent) -> Future(unit) {
  // Runs on a DIFFERENT thread!
  // Completely isolated - no shared memory
});
```

## Motivation

### Why Single-Threaded Async?

1. **Simplicity**: No thread safety concerns, no Send trait needed for async
2. **No data races**: All async code runs on one thread
3. **Memory Efficiency**: State machines only need ~100-500 bytes per task
4. **Massive Concurrency**: Can handle millions of concurrent tasks
5. **Zero-Cost Abstraction**: State machine transformation at compile time
6. **Familiar Model**: Same as JavaScript, Python asyncio - proven and intuitive
7. **No Atomics Needed**: Reference counting doesn't need atomic operations

### Why Not Multi-Threaded Async?

Multi-threaded async (like Rust's tokio) adds complexity:
- Need `Send` trait to verify thread safety
- Need atomic reference counting
- Need cross-thread synchronization
- Work-stealing adds overhead

Yo's approach: Keep async simple (single-threaded), use `spawn` for parallelism (isolated threads).

## Language Syntax

```yo
// Async function - MUST return Future(T) type
fetch_data :: (fn(url: String) -> Future(Data)) async {
  response := await http_get(url);
  data := await response.read();
  return data;
};

// Calling async from another async function
process :: (fn() -> Future(unit)) async {
  data := await fetch_data("http://example.com");
  println(data);
};

// Main entry point - async block starts event loop
main :: (fn() -> unit) {
  async {
    future := fetch("http://example.com");
    result := await future;
    println(result);
  };
};

// Async blocks - create inline async tasks
compute :: (fn() -> Future(i32)) {
  return async {
    x := await fetch_data("http://example.com");
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
1. Async functions **must** return `Future(T)` type
2. Async blocks `async { ... }` return `Future(T)` where T is the block's result type
3. `await` can **only** be used inside async functions or `async { ... }` blocks
4. All async code runs on the **same thread** - no thread spawning
5. `await` suspends the current coroutine and yields to other ready tasks

### Execution Model

```yo
// All three tasks run on the SAME thread
async {
  t1 := task1();  // Start task1, returns Future
  t2 := task2();  // Start task2, returns Future  
  t3 := task3();  // Start task3, returns Future
  
  // Interleaved execution:
  // - t1 runs until await, yields
  // - t2 runs until await, yields
  // - t3 runs until await, yields
  // - When t1's IO completes, resumes t1
  // - etc.
  
  await t1;
  await t2;
  await t3;
};
```

### Future Type

```yo
// Built-in Future type (compiler-generated struct)
// Future(T) has these fields:
// - state: enum { PENDING, READY }
// - state_machine: pointer to state machine
// - continuation: function pointer (resume function)
// - result: T (the result value when ready)

// Async function signature
fetch :: (fn(url: String) -> Future(String));
```

## State Machine Transformation

The compiler transforms async functions into state machines at each `await` point.

### Example Transformation

**Input Yo code:**
```yo
fetch_data :: (fn(url: String) -> Future(Data)) async {
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

3. **Async Function Entry**:
   - Allocates state machine on heap
   - Creates Future pointing to state machine
   - Returns Future immediately (does NOT block)

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

### State Machine Lifecycle

```c
// 1. Creation - allocate Future with state machine
FunctionName_Future* future = __yo_malloc(sizeof(FunctionName_Future));
future->state = PENDING;
// Initialize state machine fields...

// 2. Polling - poll repeatedly until complete
while (poll(future) == PENDING) {
  yield_to_event_loop();
}

// 3. Completion
future->state = READY;
future->result = final_value;
// Wake awaiters

// 4. Cleanup - freed when ref_count reaches 0
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
name :: (fn(...) -> Future(T)) async { ... };

// Await a future (only in async context)
result := await future;
```

### Example: Complete Async Program

```yo
// Async function
fetch :: (fn(url: String) -> Future(String)) async {
  response := await http_get(url);
  body := await response.read_body();
  return body;
};

// Async function with multiple awaits
fetch_both :: (fn(url1: String, url2: String) -> Future(String)) async {
  // Start both fetches (neither blocks!)
  f1 := fetch(url1);
  f2 := fetch(url2);
  
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

| Language | Model | Threading | Memory/Task | Max Concurrency |
|----------|-------|-----------|-------------|-----------------|
| **Yo** | Stackless state machines | **Single-threaded** | ~200 bytes | Millions |
| **JavaScript** | Stackless promises | **Single-threaded** | ~100 bytes | Millions |
| **Python (asyncio)** | Stackless coroutines | **Single-threaded** | ~200 bytes | Millions |
| **Rust (single-threaded executor)** | Stackless futures | **Single-threaded** | ~100 bytes | Millions |
| **Rust (tokio multi-threaded)** | Stackless futures | Multi-threaded | ~100 bytes | Millions |
| **Go** | Stackful goroutines | Multi-threaded | 2KB+ | 100K-1M |

**Note**: Yo's single-threaded async is most similar to JavaScript and Python asyncio:
- ✅ Simple mental model (no thread safety)
- ✅ No Send/Sync traits needed
- ✅ No atomic RC overhead
- ✅ Familiar to web developers

For parallelism, use `spawn` (see `PARALLELISM.md`).

## Summary

Yo's async/await provides:

1. ✅ **Single-threaded concurrency** - all async runs on one thread
2. ✅ **No thread safety concerns** - no data races possible
3. ✅ **Familiar syntax** - like JavaScript, Python, C#
4. ✅ **State machine transformation** - zero-cost abstraction
5. ✅ **Non-atomic RC** - no synchronization overhead
6. ✅ **Memory efficient** - millions of concurrent tasks (~200 bytes each)
7. ✅ **Simple mental model** - no Send trait, no work stealing
8. ✅ **Zero-cost** - compiled to efficient C code

### Quick Reference

```yo
// Define async function
fetch :: (fn(url: String) -> Future(Data)) async {
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
  task1 := fetch(url1);  // Returns immediately
  task2 := fetch(url2);  // Returns immediately
  result1 := await task1;  // Suspend until ready
  result2 := await task2;  // Suspend until ready
};

// Async blocks
compute :: (fn() -> Future(i32)) {
  return async {
    x := await get_value();
    y := await process(x);
    return x + y;
  };
};
```

### Key Principles

1. **`async { ... }` blocks** - start event loop, return Future(T)
2. **Single-threaded** - all async code runs on the calling thread
3. **`await` yields** - suspends coroutine, yields to other ready tasks
4. **State machines** - compiler transforms each `await` into state transition
5. **No thread safety** - no Send trait, no atomics, no data races
6. **Non-atomic RC** - simple reference counting (no synchronization)
7. **Event loop** - polls ready tasks, checks IO completion
8. **Zero-cost** - compiled to efficient C code

### When to Use What

| Use Case | Mechanism |
|----------|-----------|
| IO-bound concurrent tasks | `async/await` |
| CPU-bound parallel computation | `spawn` (see PARALLELISM.md) |
| Background processing | `spawn` (see PARALLELISM.md) |
| Waiting for multiple IOs | `async/await` |
| Utilizing multiple CPU cores | `spawn` (see PARALLELISM.md) |
