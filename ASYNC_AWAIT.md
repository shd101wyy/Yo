# Async/Await - Stackless Coroutines for Yo

## Philosophy

Yo uses **async/await with state machine transformation** for efficient concurrent programming. This is a stackless coroutine model similar to Rust, JavaScript, C#, and Python.

**Spawning Model**: Yo uses **eager spawning** (JavaScript/Python-style) rather than lazy spawning (Rust-style). When you create an async block, the task starts executing immediately on a worker thread. This makes the behavior more intuitive and matches what most developers expect from async/await.

```rust
// Task starts immediately when async block is created
task := async { expensive_computation() };  // Already running!
result := await task;  // Just waits for it to finish
```

## Motivation

### Why Stackless Coroutines?

1. **Memory Efficiency**: State machines only need ~100-500 bytes per task (vs 16KB-1MB for stackful)
2. **Massive Concurrency**: Can spawn millions of async tasks simultaneously
3. **Zero-Cost Abstraction**: State machine transformation at compile time, no runtime overhead
4. **Familiar Syntax**: `async`/`await` is proven across many modern languages
5. **Better for CPU-bound tasks**: Futures can be polled without context switching

## Language Syntax

```rust
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

// Main entry point
main :: (fn() -> unit) {
  async {
    // Spawn and await
    future := fetch("http://example.com");  // Task not started yet
    result := await future;  // Wait for completion (only in async block!)
    println(result);
  };
};

// Async blocks - spawn inline async tasks
compute :: (fn() -> unit) {
  // Async block returns Future(T)
  future := async {
    x := await fetch_data("http://example.com");
    y := await process_data(x);
    return y;
  };
  
  // Can await in another async context
  result := await future;  // Error: await only in async block!
};
```

### Keywords

```rust
async { ... }    // Async block expression (returns Future)
await            // Suspend until Future ready (only in async functions and blocks!)
```

**Important Rules**:
1. Async functions **must** explicitly return `Future(T)` type
2. Async blocks `async { ... }` return `Future(T)` where T is the block's result type
3. `await` can **only** be used inside `async { ... }` blocks (async coloring)
4. Async functions and blocks start executing **immediately** when created (eager spawning - JavaScript-style)
5. `await` suspends the current async function/block until the Future completes

```rust
task := fetch(url); // The task starts running IMMEDIATELY

result := await task;  // Wait for the task to complete
```

### Async Blocks

Async blocks allow you to create inline async tasks:

```rust
// Async block example
compute :: (fn() -> Future(i32)) {
  // Async block spawns immediately and returns Future
  return async {
    x := await get_value();
    y := await process(x);
    return x + y;
  };
};

// Can be awaited in async context
process :: (fn() -> Future(unit)) async {
  result := await compute();  // Await the Future from async block
  println(result);
};
```

**Note**: In Yo, async blocks use **eager spawning** (JavaScript-style). When you create an async block, it immediately starts executing on a worker thread. This is different from Rust's lazy Futures but matches JavaScript's Promise behavior, making it more intuitive for most developers.

### Future Type

```rust
// Built-in Future type (compiler-generated struct with reference counting)
// Future(T) has these fields:
// - header: yo_ref_header_t (for reference counting with BRC)
// - state: atomic enum { YO_FUTURE_RUNNING, YO_FUTURE_COMPLETED }
// - state_machine: pointer to state machine
// - continuation_fn: atomic function pointer (resume function for awaiter)
// - continuation_sm: atomic pointer (state machine of awaiter)
// - result: T (the result value when completed)

// Async function signature - return Future(T)
fetch :: (fn(url: String) -> Future(String));
```

## State Machine Transformation

The compiler transforms async functions into state machines at each `await` point.

### Example Transformation

**Input Yo code:**
```rust
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
   - Holds pending futures (future1, future2)

2. **Resume Function**:
   - Switch statement with one case per state
   - State 0: Call http_get, check if ready
   - State 1: Extract response result, call read, check if ready
   - State 2: Extract data result, complete result Future, wake awaiter

3. **Async Function Entry**:
   - Allocates state machine on heap
   - Allocates result Future with BRC header
   - Spawns state machine to worker thread
   - Returns Future immediately

### Key Points
- Each `await` becomes a state transition
- Local variables used across `await` are captured in state struct
- Resume function is a switch statement advancing through states
- Variables not used after `await` are stack-allocated in each state
- Continuations are registered atomically to wake awaiting tasks

## Runtime Architecture

### Worker Thread Pool

Thread allocation:
- Number of worker threads = hardware threads - 1 (reserve 1 core for GC thread)
- Example: 8-core CPU → 7 async worker threads + 1 GC thread

Each worker thread:
- Is a real OS thread (1:1 mapping)
- Is pinned to a dedicated CPU core for cache locality
- Has its own task queue (no lock contention between workers)
- Executes state machine continuations
- Can execute tasks from any async block (task migration enabled by tracing GC)

### Continuation

A continuation represents a state machine waiting to be resumed:
- Resume function pointer
- State machine pointer
- Linked list pointers for queue

### Worker Loop

Each worker continuously:
1. Dequeues a continuation from its queue (with mutex)
2. If no tasks, sleeps briefly (1ms)
3. Executes the continuation's resume function
4. Frees the continuation

### Task Assignment and Migration

- Async tasks are assigned to workers round-robin when spawned
- Tasks can migrate between workers via **work-stealing**
- **Historical note**: The old Biased Reference Counting (BRC) required tasks to stay on their owner thread. With the new concurrent tracing GC, this constraint is removed.
- **Work-stealing is now implemented** for automatic load balancing

### Work-Stealing Scheduler

Yo uses a **work-stealing scheduler** for optimal load balancing:

**Architecture:**
- Each worker has a **double-ended queue (deque)**
- Workers execute tasks from the **bottom** of their own deque (LIFO for cache locality)
- Idle workers **steal** tasks from the **top** of other workers' deques (FIFO to avoid conflicts)

**Benefits:**
- **Automatic load balancing** - busy workers offload to idle workers
- **Cache locality** - workers prefer their own tasks (LIFO from bottom)
- **Low contention** - stealing uses locks, but owner operations are lock-free
- **Scalability** - works efficiently with varying task durations

**Implementation Details:**
- **Lock-free owner operations** - push/pop from bottom without locks
- **Locked stealing** - thieves use mutex to steal from top
- **Random victim selection** - idle workers randomly pick victims to steal from
- **Quick checks** - workers check victim queue size before attempting steal
- **Exponential backoff** - workers try local queue multiple times before stealing

## Implementation Details

### Await Point Analysis

The compiler:
1. Walks the AST of async function bodies
2. Identifies all `await` expressions
3. Numbers them sequentially (0, 1, 2, ...)
4. Identifies all local variables that need to be captured

### State Machine Struct Generation

For each async function with await, generate a struct containing:
- Current state ID
- Result Future pointer
- All captured local variables
- All pending Futures from await expressions

### State Generation

Split the function body at each await:
- **State 0**: From start to first await
- **State 1**: From first await to second await
- **State N**: From last await to return

Each state:
1. Executes code until next await/return
2. Updates state machine's `state` field
3. If await: check if Future is ready
   - Ready: continue immediately (goto next state)
   - Not ready: register continuation, return (yield)
4. If return: mark result Future as completed, wake awaiter, free state machine

### Await Operator Implementation

At each await point:
1. Call async function, get Future
2. Update state machine state to next state
3. Check if Future is ready (atomic load)
   - If ready: extract result, continue to next state
   - If not ready: register continuation, return (yield)

## Memory Management

### State Machine Lifecycle

```c
// 1. Creation - allocate Future with state machine
FunctionName_Future* future = __yo_malloc(sizeof(FunctionName_Future));
future->header = (yo_ref_header_t){.strong = 1, .weak = 1};  // Initial reference
future->state = YO_FUTURE_RUNNING;
// Initialize state machine fields...

// 2. Execution - resume repeatedly until complete
resume_function(future->state_machine);  // May return multiple times at await points

// 3. Completion - mark Future as completed in final state
future->state = YO_FUTURE_COMPLETED;
future->result = final_value;
// Wake awaiter if any

// 4. Cleanup - Future and state machine freed when reference count reaches 0
// This happens automatically via BRC when:
// - Future is completed (state = YO_FUTURE_COMPLETED)
// - Combined reference counter reaches 0 (strong + weak = 0)
// The finalizer calls __yo_free(future) which frees both Future and embedded state machine
```

### State Machine Memory

State machines are **heap-allocated** but small (~32-500 bytes):
- State ID: 4 bytes
- Captured parameters: varies
- Captured locals: varies
- Pending Futures: 8 bytes each

**Example**: Simple async function with 2 await points = ~32 bytes total

## Performance Characteristics

### Memory Usage

**10,000 concurrent async operations:**
- State machines: 10,000 × ~200 bytes = 2MB
- Total: ~2MB

**Comparison with other concurrency models:**
- 10,000 Go goroutines (stackful) × 16KB = 160MB ❌
- 10,000 async tasks: ~2MB ✅

### Scalability

**Worker thread pool:**
- Fixed number of OS threads (configurable, default = hardware threads)
- Tasks distributed round-robin to workers
- Each worker has independent task queue (no contention)
- Can handle millions of concurrent tasks

### Throughput

**Async task execution:**
- State machine poll: ~10-50ns per poll
- No context switching overhead
- No stack allocation
- Cache-friendly (small state machines)

## API

### Concurrency Control

```rust
// Set the number of OS worker threads (default: hardware thread count)
Concurrency.set_maximum_threads(n: usize) -> unit
```

### Example: Complete Async Program

```rust


// Async worker function - MUST return Future(T)
worker :: (fn(id: i32) -> Future(i32)) async {
  printf("Worker %d starting\n", id);
  // Simulate some async work
  i := 0;
  while i < 1000, {
    i = i + 1;
  };
  printf("Worker %d done\n", id);
  return id * 10;
};

// Fetch multiple results concurrently
fetch_many :: (fn(count: i32) -> Future(unit)) async {
  // Spawn all tasks
  i := 0;
  futures := [];
  while i < count, {
    futures.push(worker(i));
    i = i + 1;
  };
  
  // Await all results
  i = 0;
  while i < count, {
    result := await futures[i];
    printf("Result %d: %d\n", i, result);
    i = i + 1;
  };
};

// Using async blocks
compute_with_block :: fn() -> Future(i32) {
  // Async block spawns inline
  return async {
    x := await worker(1);
    y := await worker(2);
    return x + y;
  };
};

// Main entry point
main :: (fn() -> unit) {
  async {
    // Set worker threads
    Concurrency.set_maximum_threads(4);
    
    // Run tasks
    await fetch_many(10);
    
    // Use async block
    block_result := await compute_with_block();
    printf("Block result: %d\n", block_result);
    
    printf("All tasks completed\n");
  };
};
```

## Comparison with Other Languages

| Language | Model | Spawning | Memory/Task | Max Concurrency | Work Stealing |
|----------|-------|----------|-------------|-----------------|---------------|
| **Yo** | Stackless state machines | **Eager** | ~200 bytes | Millions | ✅ **Yes** (implemented) |
| **Rust** | Stackless futures | Lazy | ~100 bytes | Millions | Depends on executor |
| **JavaScript** | Stackless promises | **Eager** | ~100 bytes | Millions | N/A (single-threaded) |
| **Python (asyncio)** | Stackless coroutines | **Eager** | ~200 bytes | Millions | N/A (single-threaded) |
| **C#** | Stackless state machines | **Eager** | ~200 bytes | Millions | ✅ Yes |
| **Go** | Stackful goroutines | **Eager** | 2KB+ (growable) | 100K-1M | ✅ Yes |
| **Java Virtual Threads** | Stackful | **Eager** | 1MB | ~10K | ✅ Yes |

**Note**: Yo's eager spawning matches JavaScript, Python, C#, and Go, making it more familiar to developers from those backgrounds. Unlike Rust's lazy Futures, Yo's async blocks start running immediately when created.

## Summary

Yo's async/await provides:

1. ✅ **Familiar async/await syntax** - like Rust, JavaScript, C#, Python
2. ✅ **State machine transformation** - zero-cost abstraction at compile time
3. ✅ **Work-stealing scheduler** - automatic load balancing across workers
4. ✅ **Memory efficiency** - millions of concurrent tasks (~200 bytes each)
5. ✅ **Worker thread pool** - efficient parallel execution (hardware threads - 1 for async, 1 for GC)
6. ✅ **Simple to learn** - just `async` block and `await` future
7. ✅ **GC-friendly** - concurrent tracing GC runs on dedicated thread without blocking async work

### Quick Reference

```rust
// Define async function - MUST return Future(T)
fetch :: (fn(url: String) -> Future(Data)) async {
  response := await http_get(url);
  data := await response.read();
  return data;
};

// Call async function
main :: (fn() -> unit) {
  async {
    data := await fetch("http://example.com");
    println(data);
  };
};

// Spawn multiple tasks
task1 := fetch("http://example.com");  // Starts immediately (eager spawn)
task2 := fetch("http://rust-lang.org");  // Starts immediately (eager spawn)
result1 := await task1;  // Wait for completion
result2 := await task2;  // Wait for completion

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

1. **`async { ... }` blocks** - create inline async tasks that return Future(T)
2. **Eager execution** - tasks start running immediately when created (JavaScript-style)
3. **`await` waits for result** - suspends until Future ready (only in async contexts)
4. **State machines** - compiler transforms each `await` into state transition
5. **Task migration** - tasks can move between workers (tracing GC enables safe migration)
6. **Zero-cost** - no runtime overhead, compiled to efficient C code
