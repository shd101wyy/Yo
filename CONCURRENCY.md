# Concurrency Model

Yo implements a **thread-per-core model** with async/await using stackless state machines. Tasks can be selectively work-stolen based on capture analysis, enabling efficient load balancing while maintaining thread-local cycle collection with zero stop-the-world pauses.

## Threading Model

Yo uses a **1:1 threading model** with selective work-stealing:
- Each worker thread is a real OS thread (1:1 mapping)
- **Selective work stealing** - tasks without cycle-forming captures can migrate
- Thread-per-core pinning for optimal cache locality
- Tasks distributed round-robin at spawn time
- Use Future-based async/await

This differs from M:N models because:
- Still 1:1 thread mapping (one OS thread per worker)
- Tasks maintain thread affinity if they capture cycle-forming types
- Work stealing only for acyclic captures (like Nim's ORC)

## Technology Stack

- **Async Model**: Stackless state machines (compile-time transformation)
- **Threading Model**: 1:1 (thread-per-core with selective work-stealing)
- **Threading**: OS threads (pthread/Windows threads)
- **Memory Management**: Non-atomic RC with thread-local cycle collection
- **Memory Allocator**: mimalloc
- **Synchronization**: Per-thread task queues with mutexes
- **Scheduling**: Cooperative polling within each worker thread
- **Task Distribution**: Round-robin assignment at spawn time
- **Work Stealing**: Selective - only tasks without cycle-forming captures

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Main Thread                        │
│  - Calls Concurrency.set_maximum_threads(N)         │
│  - Spawns N worker threads (OS threads)             │
│  - Spawns main() as async task on worker 0          │
└─────────────────────────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        │                               │
┌───────▼──────────┐            ┌────────▼────────┐
│  Worker Thread 1 │            │ Worker Thread N │
│  (OS Thread)     │    ...     │  (OS Thread)    │
├──────────────────┤            ├─────────────────┤
│ Task Queue       │            │ Task Queue      │
│  ┌────────────┐  │            │  ┌────────────┐ │
│  │ Task A     │  │            │  │ Task X     │ │
│  │ Task B     │  │            │  │ Task Y     │ │
│  │ Task C     │  │            │  │ Task Z     │ │
│  └────────────┘  │            │  └────────────┘ │
│                  │            │                 │
│ Async State      │            │ Async State     │
│ Machine Polling  │            │ Machine Polling │
└──────────────────┘            └─────────────────┘
```

## Key Components

### 1. **Worker Threads (OS Threads)**
- Created via `Concurrency.set_maximum_threads(N)`
- Each worker is a real OS thread (pthread/Windows thread)
- Workers run independently and in parallel
- Each worker has its own task queue (no contention)
- **CPU Affinity**: Each worker is pinned to a dedicated CPU core
  - Worker 0 → Core 0, Worker 1 → Core 1, etc.
  - Maximizes cache locality, reduces context switching
  - Implementation:
    - **Linux**: Direct `syscall(203/122/241, ...)` for `sched_setaffinity` (no libc dependency)
    - **Windows**: `SetThreadAffinityMask()` API
    - **macOS**: `thread_policy_set()` with `THREAD_AFFINITY_POLICY`

### 2. **Async Tasks (State Machines)**
- Created by calling async functions
- Each task is a small heap-allocated state machine (~100-500 bytes)
- Tasks are distributed round-robin to worker threads
- Run cooperatively - poll repeatedly until complete
- Tasks voluntarily yield at `await` points
- **Stealability determined by compiler** - based on captured types

### 3. **Selective Work Stealing**
- Idle threads can steal tasks from busy threads
- **Stealability check**: Compiler analyzes captured values
  - ✅ **Stealable**: Primitives, value types, acyclic Rc (Box, Array of values)
  - ❌ **Non-stealable**: Objects/closures with reference-type fields (can form cycles)
- **Why this works**: Non-cycle-forming types don't need thread-local GC tracking
- **Benefits**: Good load balancing + zero GC pauses (thread-local collection)

## API

### Concurrency Control
```yo
// Set the number of OS worker threads (default: hardware thread count)
Concurrency.set_maximum_threads(n: usize) -> unit
```

### Async/Await
```yo
// Define async function
fetch :: (fn(url: String) -> Future(Data)) async {
  response := await http_get(url);
  data := await response.read();
  return data;
};

// Call async function (spawns immediately, returns Future)
future := fetch("http://example.com");

// Wait for result
data := await future;
```

## Execution Model

### Task Lifecycle

1. **Spawn**: Async function called → state machine allocated → assigned to worker (round-robin)
2. **Analyze**: Compiler determines if task is stealable (no cycle-forming Rc captures)
3. **Enqueue**: State machine wrapped in continuation, enqueued to worker's task queue
4. **Execute**: Worker dequeues continuation, calls resume function
5. **Poll**: Resume function advances state machine through states
6. **Await**: If Future not ready, register continuation and return (yield)
7. **Steal** (optional): If task is stealable, idle worker may steal it
8. **Wake**: When Future completes, continuation re-enqueued to current worker
9. **Complete**: State machine reaches final state, frees itself, wakes awaiter

### Cooperative Scheduling

Tasks cooperate within each worker thread:
- **No preemption** - tasks run until they voluntarily yield at `await`
- **Yields occur at**: `await` expressions only
- **State machines**: Compiler-generated switch statements, no stack overhead
- **Fast polling**: Simple function calls, no context switching

### Parallelism

Workers run in parallel across CPU cores:
- **True parallelism** - multiple workers execute simultaneously
- **Independent queues** - no lock contention for task scheduling
- **Lock-free when possible** - atomic operations for wakeups

## Implementation Details

### Task Representation
- Each task is represented as a **continuation** with:
  - Resume function pointer
  - State machine pointer
  - Linked list pointers for queue

### Worker Structure
- Each worker thread maintains:
  - Thread handle and ID
  - CPU core ID (for affinity)
  - Task queue (head, tail, count)
  - Mutex protecting the queue

### Worker Loop
Each worker continuously:
1. Dequeues a task from its queue (with mutex lock)
2. If no tasks, sleeps briefly (1ms)
3. Executes the task's resume function
4. Frees the continuation (state machine frees itself when complete)

## Synchronization

### Task Wakeup
When a Future completes:
1. Sets Future state to COMPLETED (atomic)
2. Retrieves registered continuation (atomic)
3. Re-enqueues continuation to worker thread

### Global Task Counter
- Atomic counter tracks active tasks
- Incremented on spawn, decremented on completion
- Used by `__yo_async_wait_all()` to detect completion

## Memory Management & Cycle Collection

### Non-Atomic RC with Thread-Local GC (Nim's Approach)

Yo uses **non-atomic reference counting** with **thread-local cycle collection**:
- Each object's RC is non-atomic (no atomic operations!)
- Each thread has its own cycle collector (no global coordination)
- Objects that can form cycles must stay on their thread for GC correctness

**Why selective work stealing?**

Thread-local GC requires that **objects stay on the thread that tracks them**:

```yo
// Thread 1
async {
  node := Node(1, .None);     // Created on Thread 1
                              // Tracked by Thread 1's GC
  await(io_operation());
  // If stolen to Thread 2:
  // - Thread 1's GC still tracks 'node'
  // - But Thread 2 is using 'node'
  // - Thread 1's GC might collect it!
  // - MEMORY CORRUPTION!
}
```

**Solution:** Tasks capturing cycle-forming types cannot be stolen (thread affinity).

### Compiler Analysis for Stealability

The compiler determines stealability at async function creation:

```yo
// ✅ Stealable: Only captures primitives and acyclic types
async {
  x := box(42);           // Box(i32) - acyclic, Sendable ✅
  y := [1, 2, 3];         // Array(i32) - acyclic, Sendable ✅
  result := await(compute(x, y));
  return result;
}

// ❌ Non-stealable: Captures cycle-forming type
async {
  node := Node(1, .None);  // Node can form cycles, NOT Sendable ❌
  cycle := await(process(node));
  // Must stay on thread for GC
}
```

**Send Trait Rules**:

| Type | Sendable? | Reason |
|------|-----------|--------|
| Primitives (`i32`, `boolean`, etc.) | ✅ Auto | No thread safety issues |
| Value types (`struct(...)`) | ✅ Auto | No internal references |
| `Box(T)` where T is value | ✅ Auto | Acyclic, no internal refs |
| `Array(T)` where T is value | ✅ Auto | Acyclic, no internal refs |
| `*T` (pointers) | ❌ Never | Borrows not thread-safe |
| **`object(...)` without cycle-forming fields** | ⚠️ **If no ref fields** | **Sendable if acyclic** |
| **`object(...)` with ref fields** | ❌ **Not by default** | **Can form cycles** |
| **`Fn(...)` capturing only values** | ✅ **Via `Impl(Fn, Send)`** | **Compiler verifies captures** |
| **`Fn(...)` capturing cycle-forming** | ❌ **Cannot be `Send`** | **Captures cycle-forming types** |
| **`Dyn(Trait)`** | ⚠️ **Via `Dyn(Trait, Send)`** | **Trait object must be Send** |
| **`Future(T)`** | ⚠️ **Via `Impl(Future(T), Send)`** | **State machine must be Send** |

**Key Design Decision:** Cycle-forming Rc types are **never Sendable**. This ensures:
- Each thread's GC only tracks objects created on that thread
- No cross-thread GC coordination needed
- Simple, safe thread-local cycle collection

**To make closures/futures Sendable**, explicitly mark with `Send` trait:
```yo
// Not Sendable by default (might capture cycle-forming types)
f : impl(Fn(i32) -> i32)

// Sendable version (compiler verifies no cycle-forming captures)
f : Impl(Fn(i32) -> i32, Send)  // ✅ OK if captures only primitives

// Example: Sendable closure capturing only values
x := 42;
y := 100;
(f_send : Impl(Fn() -> i32, Send)) = (() => (x + y));  // ✅ OK

// Example: Cannot be Send - captures cycle-forming type
node := Node(1, .None);
(f_bad : Impl(Fn() -> i32, Send)) = (() => node.value);  // ❌ ERROR!
// Error: Cannot implement Send - captures 'node' which can form cycles

// Example: Sendable trait object
processor : Dyn(Processor, Send)  // ✅ OK if Processor is Send

// Example: Sendable future
fut : Impl(Future(i32), Send) = async {  // ✅ OK if captures only Send types
  compute(42)
};
```

**Type analysis for stealability**:
- Task captures only `Send` types → Stealable
- Task captures non-`Send` types → Non-stealable (thread affinity)

### Thread-Local Collection Benefits

**No stop-the-world pauses:**
- Each thread collects independently
- Other threads continue running during collection
- Pause time: 0.5-5ms per thread (only that thread's objects)

**Perfect scaling:**
- N threads = N independent collectors
- No global synchronization
- True parallelism

See `CYCLE_COLLECTION.md` for detailed GC implementation.

## Performance Characteristics

### Strengths
✅ **Minimal overhead** - state machines are just structs + switch statements  
✅ **No context switching** - polling is simple function calls  
✅ **True parallelism** - workers run on multiple cores  
✅ **Scalable** - per-worker queues eliminate contention  
✅ **Memory efficient** - ~200 bytes per task vs 16KB+ for stackful  
✅ **Millions of tasks** - can handle massive concurrency  
✅ **CPU affinity** - thread-per-core model maximizes cache locality  
✅ **Zero-cost abstraction** - compiled to efficient C code  
✅ **Good work stealing** - most tasks are stealable  
✅ **Non-atomic RC** - zero synchronization overhead in hot path  
✅ **Zero GC pauses** - thread-local collection, no stop-the-world

### Weaknesses
⚠️ **Async coloring** - async functions can only await other async functions  
⚠️ **Cannot suspend in C calls** - must wrap blocking C functions  
⚠️ **Explicit await points** - cannot suspend arbitrarily like stackful coroutines  
⚠️ **Thread affinity** - tasks capturing cycle-forming types cannot migrate

### Trade-offs

| Feature | Yo (Stackless) | Go (Stackful) |
|---------|----------------|---------------|
| Memory/task | ~200 bytes | 2KB+ (growable) |
| Max concurrent tasks | Millions | 100K-1M |
| Suspend anywhere | ❌ Only at await | ✅ Anywhere |
| C interop | ⚠️ Must wrap blocking calls | ✅ Direct |
| Syntax | async/await | go {}, channels |
| Runtime overhead | Near-zero | Context switching |

## Example

```yo


main :: (fn() -> unit) {
  async {
    // Create 2 OS worker threads
    Concurrency.set_maximum_threads(2);
    
    // Spawn 4 async tasks (distributed round-robin to 2 workers)
    task1 := worker(1);  // → Worker 0
    task2 := worker(2);  // → Worker 1
    task3 := worker(3);  // → Worker 0
    task4 := worker(4);  // → Worker 1
    
    // Await all results
    result1 := await task1;
    result2 := await task2;
    result3 := await task3;
    result4 := await task4;
    
    printf("All tasks completed: %d, %d, %d, %d\n", result1, result2, result3, result4);
  };
};

worker :: (fn(id: i32) -> Future(i32)) async {
  printf("Worker %d on thread %zu\n", id, Concurrency.get_thread_id());
  // Do some async work...
  return id * 10;
};
```

**Output** (order may vary):
```
Worker 1 on thread 140123456789
Worker 2 on thread 140123456790
Worker 3 on thread 140123456789  // Same as Worker 1 (thread affinity)
Worker 4 on thread 140123456790  // Same as Worker 2 (thread affinity)
All tasks completed: 10, 20, 30, 40
```

## Comparison with Other Models

| Feature | Yo (Async/Await) | Go (Goroutines) | Rust (async/await) |
|---------|------------------|-----------------|-------------------|
| Threading Model | Thread-per-core | M:N with work stealing | Executor-dependent |
| Coroutine Type | Stackless (state machines) | Stackful (growable stacks) | Stackless (state machines) |
| Task Scheduling | Cooperative | Preemptive | Cooperative |
| Work Stealing | ✅ Selective (acyclic captures) | ✅ Yes | Depends on executor |
| Memory/Task | ~200 bytes | 2KB+ (growable) | ~100-500 bytes |
| Stack Growth | N/A (no stacks) | Dynamic 2KB→1GB | N/A (no stacks) |
| Max Concurrent | Millions | 100K-1M | Millions |
| Suspend Anywhere | ❌ Only at await | ✅ Anywhere | ❌ Only at await |
| C Interop | ⚠️ Must wrap blocking calls | ✅ Direct | ⚠️ Must wrap blocking calls |
| Syntax | async/await | go {}, channels | async/await |
| Runtime Overhead | Near-zero | Context switching | Near-zero |
| CPU Affinity | ✅ Thread-per-core pinning | ⚠️ GOMAXPROCS only | Depends on executor |
| Memory Model | Non-atomic RC + cycle GC | Mark-sweep GC | Manual (Arc/Rc) |
| GC Coordination | Thread-local (0.5-5ms/thread) | Stop-the-world (10-100ms+) | N/A (no GC) |
| Channels/Select | ❌ No (use Future) | ✅ Native | ⚠️ Crate-dependent |

## Key Advantages

**Vs Go**:
- ✅ Non-atomic RC faster than Go's GC in hot path (zero synchronization)
- ✅ Zero GC pauses - thread-local collection while others continue
- ✅ Lower memory per task (~200 bytes vs 2KB+)
- ✅ Thread-per-core affinity for better cache locality
- ✅ Selective work stealing for good load balancing

**Vs Rust**:
- ✅ Automatic memory management (no manual Arc/Rc juggling)
- ✅ Built-in cycle collection (Rust's Rc has cycle leak risk)
- ✅ Simpler mental model (no lifetime annotations)
- ⚠️ Less control over memory layout

**Unique Features**:
- Non-atomic RC with thread-local GC (zero global pauses)
- Selective work stealing based on compiler analysis
- Thread-per-core + optional work stealing
- Zero synchronization overhead in RC operations

## Future Enhancements

- [ ] Task priorities
- [ ] Task cancellation
- [ ] Async I/O integration (epoll/kqueue/io_uring/IOCP)
- [ ] Select/race for multiple Futures
- [ ] Timeout support
- [ ] Async mutexes and condition variables
- [ ] Work-stealing statistics and tuning
- [ ] Compiler optimization: inline small async functions