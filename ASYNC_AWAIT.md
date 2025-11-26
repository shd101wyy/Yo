# Async/Await - Stackless Coroutines for Yo

## Philosophy

Yo uses **async/await with state machine transformation** for efficient concurrent programming. This is a stackless coroutine model similar to Rust, JavaScript, C#, and Python.

**Spawning Model**: Yo uses **eager spawning** (JavaScript/Python-style) rather than lazy spawning (Rust-style). When you create an async block, the task starts executing immediately on a worker thread. This makes the behavior more intuitive and matches what most developers expect from async/await.

**Concurrency Model**: Yo uses **selective work-stealing** with **thread-local cycle collection**. Tasks that capture only `Send` types (primitives, value types, acyclic Rc) can be work-stolen between threads. Tasks that capture cycle-forming types maintain thread affinity for safe garbage collection.

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
6. **Non-atomic RC**: Reference counting without atomic operations (zero synchronization overhead)
7. **Thread-local GC**: Each thread collects cycles independently (no stop-the-world pauses)

## Language Syntax

```rust
// Async function - MUST return Impl(Future(T)) type
fetch_data :: (fn(url: String) -> Impl(Future(Data))) async {
  response := await http_get(url);
  data := await response.read();
  return data;
};

// Calling async from another async function
process :: (fn() -> Impl(Future(unit))) async {
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
  // Async block returns Impl(Future(T))
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
1. Async functions **must** explicitly return `Impl(Future(T))` type
2. Async blocks `async { ... }` return `Impl(Future(T))` where T is the block's result type
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
compute :: (fn() -> Impl(Future(i32))) {
  // Async block spawns immediately and returns Impl(Future(T))
  return async {
    x := await get_value();
    y := await process(x);
    return x + y;
  };
};

// Can be awaited in async context
process :: (fn() -> Impl(Future(unit))) async {
  result := await compute();  // Await the Future from async block
  println(result);
};
```

**Note**: In Yo, async blocks use **eager spawning** (JavaScript-style). When you create an async block, it immediately starts executing on a worker thread. This is different from Rust's lazy Futures but matches JavaScript's Promise behavior, making it more intuitive for most developers.

### Future Type

```rust
// Built-in Future module (compiler-generated struct with reference counting)
// Impl(Future(T)) has these fields:
// - header: yo_ref_header_t (for non-atomic reference counting)
// - state: atomic enum { YO_FUTURE_RUNNING, YO_FUTURE_COMPLETED }
// - state_machine: pointer to state machine
// - continuation_fn: atomic function pointer (resume function for awaiter)
// - continuation_sm: atomic pointer (state machine of awaiter)
// - result: T (the result value when completed)
// - is_stealable: bool (whether task can be work-stolen)

// Async function signature - return Impl(Future(T))
fetch :: (fn(url: String) -> Impl(Future(String)));

// Sendable Future - can be work-stolen between threads
fetch_send :: (fn(url: String) -> Impl(Future(String), Send));
```

## State Machine Transformation

The compiler transforms async functions into state machines at each `await` point.

### Example Transformation

**Input Yo code:**
```rust
fetch_data :: (fn(url: String) -> Impl(Future(Data))) async {
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

Each worker thread:
- Is a real OS thread (1:1 mapping)
- Is pinned to a dedicated CPU core (thread-per-core model)
- Has its own task queue (no contention)
- Has its own cycle collector (thread-local GC)
- Executes state machine continuations

### Continuation

A continuation represents a state machine waiting to be resumed:
- Resume function pointer
- State machine pointer
- Linked list pointers for queue
- **Stealability flag** (whether task can be work-stolen)

### Worker Loop

Each worker continuously:
1. Dequeues a continuation from its queue (with mutex)
2. If no tasks, tries to **steal from other workers** (if stealable)
3. If still no tasks, sleeps briefly (1ms)
4. Executes the continuation's resume function
5. Frees the continuation

### Selective Work Stealing

Yo uses **selective work-stealing** based on captured types:

```rust
// ✅ Stealable: Only captures Send types (primitives, values, acyclic Rc)
async {
  x := 42;
  y := box(100);  // Box(i32) is Send
  result := await compute(x, y);
  return result;
};
// This task CAN be stolen by idle workers

// ❌ Non-stealable: Captures cycle-forming types
async {
  node := Node(1, .None);  // Node can form cycles, not Send
  await process(node);
};
// This task stays on its original thread (thread affinity)
```

**Why selective work-stealing?**
- Tasks capturing `Send` types can migrate between threads safely
- Tasks capturing cycle-forming types must stay on their thread for GC correctness
- Each thread's cycle collector only tracks objects created on that thread
- This enables **zero stop-the-world pauses** (thread-local collection)

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

### Non-Atomic Reference Counting

Yo uses **non-atomic reference counting** with **thread-local cycle collection**:
- RC operations are simple increment/decrement (no atomics in hot path)
- Each thread has its own cycle collector
- No stop-the-world pauses (other threads continue during collection)

### State Machine Lifecycle

```c
// 1. Creation - allocate Future with state machine
FunctionName_Future* future = __yo_malloc(sizeof(FunctionName_Future));
future->header = (yo_ref_header_t){.ref_count = 1};  // Non-atomic RC
future->state = YO_FUTURE_RUNNING;
future->is_stealable = /* determined by compiler based on captures */;
// Initialize state machine fields...

// 2. Execution - resume repeatedly until complete
resume_function(future->state_machine);  // May return multiple times at await points

// 3. Completion - mark Future as completed in final state
future->state = YO_FUTURE_COMPLETED;
future->result = final_value;
// Wake awaiter if any

// 4. Cleanup - Future and state machine freed when reference count reaches 0
// For cycle-forming types: freed by thread-local cycle collector
// For acyclic types: freed immediately when RC = 0
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


// Async worker function - MUST return Impl(Future(T))
worker :: (fn(id: i32) -> Impl(Future(i32))) async {
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
fetch_many :: (fn(count: i32) -> Impl(Future(unit))) async {
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
compute_with_block :: fn() -> Impl(Future(i32)) {
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

| Language | Model | Spawning | Memory/Task | Max Concurrency | Work Stealing | GC Pauses |
|----------|-------|----------|-------------|-----------------|---------------|------------|
| **Yo** | Stackless state machines | **Eager** | ~200 bytes | Millions | ✅ **Selective** (Send types) | **Zero** (thread-local) |
| **Rust** | Stackless futures | Lazy | ~100 bytes | Millions | Depends on executor | N/A (no GC) |
| **JavaScript** | Stackless promises | **Eager** | ~100 bytes | Millions | N/A (single-threaded) | ~1-10ms |
| **Python (asyncio)** | Stackless coroutines | **Eager** | ~200 bytes | Millions | N/A (single-threaded) | ~10-50ms |
| **C#** | Stackless state machines | **Eager** | ~200 bytes | Millions | ✅ Yes | ~10-50ms |
| **Go** | Stackful goroutines | **Eager** | 2KB+ (growable) | 100K-1M | ✅ Yes | 10-100ms+ |
| **Java Virtual Threads** | Stackful | **Eager** | 1MB | ~10K | ✅ Yes | Variable |

**Note**: Yo's selective work-stealing gives you the best of both worlds:
- ✅ **Load balancing** for tasks with `Send` captures (most common)
- ✅ **Zero GC pauses** via thread-local collection
- ✅ **No atomic RC overhead** (non-atomic reference counting)

## Summary

Yo's async/await provides:

1. ✅ **Familiar async/await syntax** - like Rust, JavaScript, C#, Python
2. ✅ **State machine transformation** - zero-cost abstraction at compile time
3. ✅ **Selective work-stealing** - tasks with `Send` captures can be stolen for load balancing
4. ✅ **Thread-local GC** - tasks with cycle-forming captures stay on their thread (no STW pauses)
5. ✅ **Non-atomic RC** - zero synchronization overhead in hot path
6. ✅ **Memory efficiency** - millions of concurrent tasks (~200 bytes each)
7. ✅ **Worker thread pool** - efficient parallel execution on OS threads
8. ✅ **Simple to learn** - just `async` block and `await` future

### Send Trait for Futures

```rust
// Default: Future may capture cycle-forming types (not stealable)
fetch :: (fn(url: String) -> Impl(Future(Data))) async {
  node := Node(1, .None);  // Captures cycle-forming type
  // ...
};

// Sendable: Future only captures Send types (stealable)
compute :: (fn(x: i32, y: i32) -> Impl(Future(i32), Send)) async {
  // Only captures primitives - can be work-stolen!
  return x + y;
};
```

### Quick Reference

```rust
// Define async function - MUST return Impl(Future(T))
fetch :: (fn(url: String) -> Impl(Future(Data))) async {
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
compute :: (fn() -> Impl(Future(i32))) {
  return async {
    x := await get_value();
    y := await process(x);
    return x + y;
  };
};
```

### Key Principles

1. **`async { ... }` blocks** - create inline async tasks that return Impl(Future(T))
2. **Eager execution** - tasks start running immediately when created (JavaScript-style)
3. **`await` waits for result** - suspends until Future ready (only in async contexts)
4. **State machines** - compiler transforms each `await` into state transition
5. **Selective work-stealing** - tasks with `Send` captures can migrate; others have thread affinity
6. **Non-atomic RC** - reference counting without atomic operations (zero overhead)
7. **Thread-local GC** - each thread collects cycles independently (no STW pauses)
8. **Zero-cost** - no runtime overhead, compiled to efficient C code
