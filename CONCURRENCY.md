# Concurrency Model

Yo implements a **thread-per-core model** with async/await using stackless state machines. Each async task is assigned to a specific worker thread and never migrates, enabling efficient Biased Reference Counting.

## Threading Model

Yo uses a **1:1 threading model** with task affinity:
- Each worker thread is a real OS thread (1:1 mapping)
- **No work stealing** - tasks stay on their assigned thread
- Thread-per-core pinning for optimal cache locality
- Tasks distributed round-robin at spawn time
- **No channels or select** - use Future-based async/await instead

This is **not** an M:N model because:
- No dynamic task migration between threads
- No work stealing scheduler
- Tasks maintain strict thread affinity for BRC

## Technology Stack

- **Async Model**: Stackless state machines (compile-time transformation)
- **Threading Model**: 1:1 (thread-per-core with task affinity, no work stealing)
- **Threading**: OS threads (pthread/Windows threads)
- **Memory Allocator**: mimalloc
- **Synchronization**: Per-thread task queues with mutexes
- **Scheduling**: Cooperative polling within each worker thread
- **Task Distribution**: Round-robin assignment at spawn time (tasks never migrate)

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

### 3. **Thread Affinity** (No Work Stealing)
- Once a task starts on a worker thread, it **stays on that thread**
- Tasks are never migrated between worker threads
- This is essential for **Biased Reference Counting** to work correctly
- BRC assumes objects stay on the thread that created them

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
2. **Enqueue**: State machine wrapped in continuation, enqueued to worker's task queue
3. **Execute**: Worker dequeues continuation, calls resume function
4. **Poll**: Resume function advances state machine through states
5. **Await**: If Future not ready, register continuation and return (yield)
6. **Wake**: When Future completes, continuation re-enqueued to worker
7. **Complete**: State machine reaches final state, frees itself, wakes awaiter

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

## Memory Management & BRC

### Why Thread Affinity?

Yo uses **Biased Reference Counting** (BRC) for memory management:
- Each object has an "owner thread"
- Owner thread uses fast non-atomic operations
- Non-owner threads use slower atomic operations

**Thread affinity ensures**:
- Tasks stay on the thread that created their objects
- Objects remain on their owner thread
- No unexpected ownership transfers
- BRC fast path works consistently

### Object Sharing

Objects created on one thread can be passed to tasks on other threads:
- When Future completes, result may be awaited by task on different thread
- BRC handles this transparently with owner_thread_id tracking
- Atomic operations used when necessary

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

### Weaknesses
⚠️ **Async coloring** - async functions can only await other async functions  
⚠️ **Cannot suspend in C calls** - must wrap blocking C functions  
⚠️ **Explicit await points** - cannot suspend arbitrarily like stackful coroutines

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
| Work Stealing | ❌ No (thread affinity) | ✅ Yes | Depends on executor |
| Memory/Task | ~200 bytes | 2KB+ (growable) | ~100-500 bytes |
| Stack Growth | N/A (no stacks) | Dynamic 2KB→1GB | N/A (no stacks) |
| Max Concurrent | Millions | 100K-1M | Millions |
| Suspend Anywhere | ❌ Only at await | ✅ Anywhere | ❌ Only at await |
| C Interop | ⚠️ Must wrap blocking calls | ✅ Direct | ⚠️ Must wrap blocking calls |
| Syntax | async/await | go {}, channels | async/await |
| Runtime Overhead | Near-zero | Context switching | Near-zero |
| CPU Affinity | ✅ Thread-per-core pinning | ⚠️ GOMAXPROCS only | Depends on executor |
| Memory Model | BRC (thread-local) | Mark-sweep GC | Manual (Arc/Rc) |
| Channels/Select | ❌ No (use Future) | ✅ Native | ⚠️ Crate-dependent |

## Future Enhancements

- [ ] Task priorities
- [ ] Task cancellation
- [ ] Async I/O integration (epoll/kqueue/io_uring/IOCP)
- [ ] Select/race for multiple Futures
- [ ] Timeout support
- [ ] Async mutexes and condition variables