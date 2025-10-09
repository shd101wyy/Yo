# Concurrency Model

Yo implements a **hybrid M:N### 2. **Cooperative Coroutines**
- Spawned with `async function(args)`
- Distributed round-robin to worker threads
- Run cooperatively within each worker using llco (stackful coroutines)
- Each coroutine has its own 16KB stack (minimum 16KB required by llco)
- Coroutines voluntarily yield when blocking on channels
- **Coroutine pool**: Completed coroutines are returned to a **thread-local** pool for reuse (unbounded during execution, cleaned up only at shutdown)

### 3. **Thread Affinity** (Not Work Stealing)
- Once a coroutine starts on a worker thread, it **stays on that thread**
- Coroutines are never migrated between worker threads
- This is essential for **Biased Reference Counting** to work correctly
- BRC assumes objects stay on the thread that created themodel** that combines OS-level parallelism with cooperative multitasking using stackful coroutines, similar to Go's goroutines but with some key differences.

## Technology Stack

- **Coroutine Library**: [llco](https://github.com/tidwall/llco) v1.0 - Low-Level Coroutines
- **Threading**: OS threads (pthread/Windows threads)
- **Memory Allocator**: mimalloc
- **Synchronization**: Mutexes (pthread/Windows)
- **Scheduling**: Cooperative within workers, parallel across workers
- **Coroutine Pool**: neco-inspired pool (unbounded during execution, shutdown cleanup only)

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Main Thread                        │
│  - Calls Concurrency.set_maximum_threads(N)         │
│  - Spawns N worker threads (OS threads)             │
│  - Spawns main() as a coroutine on worker 0         │
└─────────────────────────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        │                               │
┌───────▼──────────┐            ┌────────▼────────┐
│  Worker Thread 1 │            │ Worker Thread N │
│  (OS Thread)     │    ...     │  (OS Thread)    │
├──────────────────┤            ├─────────────────┤
│ Coroutine Queue  │            │ Coroutine Queue │
│  ┌────────────┐  │            │  ┌────────────┐ │
│  │ Coro A     │  │            │  │ Coro X     │ │
│  │ Coro B     │  │            │  │ Coro Y     │ │
│  │ Coro C     │  │            │  │ Coro Z     │ │
│  └────────────┘  │            │  └────────────┘ │
│                  │            │                 │
│ Cooperative      │            │ Cooperative     │
│ Scheduling       │            │ Scheduling      │
│ (llco library)   │            │ (llco library)  │
└──────────────────┘            └─────────────────┘
```

## Key Components

### 1. **Worker Threads (OS Threads)**
- Created via `Concurrency.set_maximum_threads(N)`
- Each worker is a real OS thread (pthread/Windows thread)
- Workers run independently and in parallel
- Each worker has its own task queue (thread affinity)
- **CPU Affinity**: Each worker is pinned to a dedicated CPU core (thread-per-core model)
  - Worker 0 → Core 0, Worker 1 → Core 1, etc.
  - Reduces cache misses and context switching overhead
  - Maximizes CPU cache locality
  - **Implementation**: Direct syscalls on Linux (no GNU extensions needed), native APIs on Windows/macOS

### 2. **Cooperative Tasks**
- Spawned with `async function(args)`
- Optional configurable stack size: `async function(args), { stack_size: bytes }`
- Distributed round-robin to worker threads
- Run cooperatively within each worker using llco (stackful coroutines)
- Each task has its own stack (default 16KB, configurable from 16KB to 1MB+)
- Tasks voluntarily yield when blocking on channels
- **Stack overflow detection**: Guard zones with canary values detect stack overflows in debug builds

### 3. **Thread Affinity** (Not Work Stealing)
- Once a task starts on a worker thread, it **stays on that thread**
- Tasks are never migrated between worker threads
- This is essential for **Biased Reference Counting** to work correctly
- BRC assumes objects stay on the thread that created them

## API

### Concurrency Control
```yo
// Set the number of OS worker threads (default: 1)
Concurrency.set_maximum_threads(n: i64) -> Unit

// Get current OS thread ID
Concurrency.get_thread_id() -> u64
```

### Task Spawning
```yo
// Spawn a coroutine on a worker thread (non-blocking, default 16KB stack)
async function(args...)

// Spawn with custom stack size (runtime-known, in bytes)
async function(args...), { stack_size: 1024 * 64 }  // 64KB stack

// Stack size can be any runtime expression
stack_needed := if deep_recursion, 1024 * 128, 1024 * 16;
async worker(), { stack_size: stack_needed }

// Examples:
async say("hello", 42, channel)
async worker(), { stack_size: 1024 * 128 }  // 128KB for deep recursion
async process(data), { stack_size: config.worker_stack_size }  // Dynamic
```

**Note**: Stack size is **runtime-known**, allowing dynamic computation based on program state. The coroutine pool uses **segregated free lists** for common sizes (16KB, 32KB, 64KB, 128KB, 256KB, 512KB, 1MB) for O(1) lookup, with best-fit search for custom sizes.

### Channels
```go
// Create unbuffered channel (synchronous rendezvous)
ch := chan(Type);

// Create buffered channel with capacity
ch := chan(Type, capacity);

// Send value (blocks if unbuffered and no receiver)
ch <- value;

// Receive value (blocks if no sender, returns Option)
result := <-(ch);  // Returns Option(Type)

// Select statement (Go-style)
select(
  (ch1 <- value) => { /* send succeeded */ },
  (x := <-(ch2)) => { /* receive succeeded */ },
  _ => { /* default case (non-blocking) */ }
);
```

## Execution Model

### Coroutine Lifecycle

1. **Spawn**: `async func()` gets coroutine from pool (or allocates new), assigns to worker (round-robin)
2. **Schedule**: Worker dequeues coroutine from its ready queue
3. **Execute**: Coroutine runs cooperatively on its own stack (via llco)
4. **Block**: Coroutine blocks on channel → saves context via llco → worker switches to next coroutine
5. **Wake**: Channel operation completes → coroutine moved back to ready queue
6. **Resume**: Worker restores coroutine context via llco → coroutine continues execution
7. **Complete**: Coroutine finishes → returned to pool for reuse → worker fetches next coroutine
8. **Shutdown**: All pooled coroutines are freed when `__yo_coro_wait_all()` completes

### Cooperative Scheduling

Coroutines cooperate within each worker thread:
- **No preemption** - coroutines run until they voluntarily yield
- **Yields occur on**: channel send/recv operations, select statements
- **Context switching**: llco library (stackful coroutines with separate stacks)
- **Fast switching**: no syscalls, efficient context save/restore

### Parallelism

Workers run in parallel across CPU cores:
- **True parallelism** - multiple workers execute simultaneously
- **Independent queues** - no lock contention for coroutine scheduling
- **Parallel channels** - coroutines on different workers can communicate

## Channel Semantics

### Unbuffered Channels (Rendezvous)
```yo
ch := chan(i32);  // capacity = 0

// Sender blocks until receiver is ready
async ((fn()-> unit){ ch <- 42 })();  // Blocks cooperatively

// Receiver blocks until sender is ready
value := <-(ch);  // Blocks cooperatively
```

**Select with unbuffered channels:**
```yo
// Both send and receive operations work in select
select(
  (ch1 <- value) => { /* sent when receiver ready */ },
  (x := <-(ch2)) => { /* received when sender ready */ }
);
```

### Buffered Channels
```yo
ch := chan(i32, 10);  // capacity = 10

// Sender blocks only if buffer is full
ch <- 42;  // Non-blocking if buffer has space

// Receiver blocks only if buffer is empty
value := <-(ch);  // Non-blocking if buffer has data
```

**Implementation**: (No dont yet)
- All channels use a **uniform `void*` buffer structure** regardless of element type
- Channel struct: `{ void* buffer; size_t element_size; size_t capacity; ... }`
- Elements stored at byte offsets: `(T*)((char*)buffer + index * element_size)`
- Enables **type-erased channel pooling** (future optimization)

### Cross-Thread Communication

Channels work across threads using hybrid synchronization:
- **Coroutine → Coroutine (same worker)**: Cooperative yielding via llco
- **Coroutine → Coroutine (different worker)**: Wake and enqueue to target worker
- All communication uses wait queues and cooperative scheduling

### Select Statement

Go-style select for multiplexing channel operations:
- **Two-phase algorithm**: Lock-poll-execute OR register-park-wake
- **Supports send and receive**: Both operations work in select (unlike some implementations)
- **TOCTOU-safe**: Locks all channels before checking readiness to avoid race conditions
- **Fair wakeup**: When multiple cases ready, first ready case executes (can be randomized)

## Implementation Details

### Coroutine Structure
```c
struct yo_coro {
  void (*func)(void*);           // Coroutine function
  void* data;                    // Coroutine arguments
  yo_coro_state_t state;         // READY, RUNNING, BLOCKED, COMPLETED
  void* wait_channel;            // Channel blocking on (or NULL)
  yo_select_state_t* select_state; // Non-NULL when blocked in select
  void* recv_data_ptr;           // For receive: where to store result
  struct llco* coro;             // llco coroutine handle (NULL = not started)
  char* stack;                   // Coroutine stack (allocated)
  size_t stack_size;             // Stack size (default 16KB, configurable)
  yo_worker_thread_t* owner_worker; // Worker thread that owns this coroutine
  yo_coro_t* next;               // Next in ready/blocked queue or pool
  yo_coro_t* next_wait;          // Next in channel wait queue
};
```

### Worker Structure
```c
struct yo_worker_thread {
  pthread_t handle;           // OS thread handle
  pthread_t id;               // Thread ID
  bool active;
  size_t core_id;             // CPU core this worker is pinned to
  yo_coro_queue_t ready_queue;    // Coroutines ready to run
  yo_coro_queue_t blocked_queue;  // Coroutines waiting on channels
  pthread_mutex_t queue_mutex;    // Protects queues
};
```

### Context Switching

Yo uses the **llco** (Low-Level Coroutines) library for context switching:

**Coroutine Bootstrap** (first run):
```c
1. Worker calls llco_start(&desc, false) with coroutine descriptor
2. llco switches to coroutine's stack and begins execution
3. Coroutine executes coro->func(coro->data)
4. On completion or block: llco_switch(NULL, false) returns to worker
```

**Coroutine Resume** (after blocking):
```c
1. Worker calls llco_switch(coro->coro, false)
2. llco restores coroutine's saved context (registers, stack pointer)
3. Coroutine continues from where it blocked
4. Executes remaining code
5. On completion or re-block: llco_switch(NULL, false) back to worker
```

**Key features**:
- **Automatic stack switching**: llco handles stack pointer restoration
- **Register preservation**: All registers saved/restored automatically  
- **No manual longjmp**: Clean context management via llco API
- **Stack isolation**: Each coroutine has its own stack (16KB default)

## Synchronization

### Blocking Mechanisms

**Cooperative (Coroutines)**:
- Save context with `llco_switch(NULL, false)` (returns to worker)
- Move coroutine to blocked queue
- Worker switches to next ready coroutine or waits
- On wakeup: move to ready queue, worker will resume

**Wait Queues**:
- Each channel has `send_queue` and `recv_queue`
- Coroutines register in wait queues when blocking
- When channel becomes ready, coroutines are dequeued and woken
- Intrusive queues (linked via `next_wait` pointer)

### Wakeup Strategies

**Worker-local Wakeup**:
- Wakes coroutine on its owner worker
- Enqueues to that worker's ready queue
- Used for all channel operations (coroutines have thread affinity)

**Global Coroutine Counter**:
- Atomic counter tracks active coroutines
- Incremented on spawn, decremented on completion
- Used by `__yo_coro_wait_all()` to know when all work is done

## Memory Management & BRC

### Coroutine Pool (Thread-Local)

Each worker thread maintains its own coroutine pool with **segregated free lists**:
- **Pool scope**: Thread-local (`_Thread_local` storage) - zero contention
- **Pool structure**: Separate lists for common stack sizes (16KB, 32KB, 64KB, 128KB, 256KB, 512KB, 1MB)
- **Pool size**: Unbounded during execution - grows as needed
- **Stack overflow detection**: 16-byte guard zone at stack bottom with canary values (debug builds only)
- **On spawn**: 
  1. Check segregated pool for exact size match (O(1) lookup)
  2. If not found, search custom pool for best-fit (O(n) but rare)
  3. If still not found, allocate new coroutine + stack + guard zone
- **On complete**: 
  1. Check stack guard canary for overflow (debug builds only)
  2. Return to appropriate segregated pool for reuse (never freed during execution)
- **On shutdown**: Each worker frees its own pooled coroutines when exiting
- **Thread safety**: No mutex needed - each thread owns its pool exclusively
- **Benefits**: 
  - **Zero contention** - no mutex/atomic operations for pool access
  - **O(1) pool lookup** for common sizes (16KB default covers 99% of use cases)
  - Eliminates allocation overhead for short-lived coroutines
  - **No use-after-free bugs** - coroutines never freed while workers are running
  - Stack reuse reduces memory pressure
  - Perfect alignment with thread affinity model
  - **Stack safety** - Guard zones catch overflows early (debug mode)
- **Debug mode**: Pool size tracked per thread with `YO_DEBUG_CONCURRENCY` flag

**Recommended stack sizes**: Use power-of-2 multiples of 16KB (16KB, 32KB, 64KB, 128KB, etc.) for optimal pool performance.

### Why Thread Affinity?

Yo uses **Biased Reference Counting** (BRC) for memory management:
- Each object has an "owner thread"
- Owner thread uses fast non-atomic operations
- Non-owner threads use slower atomic operations
- Object ownership can transfer but requires synchronization

**Thread affinity ensures**:
- Coroutines stay on the thread that created their objects
- Objects remain on their owner thread
- No unexpected ownership transfers
- BRC fast path works consistently

### Object Sharing

Objects can be shared between threads via channels:
- Sending object through channel transfers ownership semantics
- Receiver may be on different thread → atomic reference counting
- BRC handles this transparently with owner_thread_id tracking

## Performance Characteristics

### Strengths
✅ **Low overhead context switching** - llco is highly optimized  
✅ **No syscalls for coroutine scheduling** - all in userspace  
✅ **True parallelism** - workers run on multiple cores  
✅ **Scalable** - per-worker queues eliminate contention  
✅ **Efficient memory** - coroutines share thread resources
✅ **Fast select** - Go's proven algorithm with atomic channel locking
✅ **Coroutine reuse** - thread-local pools eliminate allocation overhead with zero contention
✅ **No use-after-free** - coroutines never freed during execution
✅ **CPU affinity** - thread-per-core model maximizes cache locality and reduces context switching
✅ **Uniform channels** - void* buffer structure enables type-erased pooling
✅ **Stack safety** - Guard zones detect stack overflows early in debug builds
✅ **Configurable stacks** - Runtime-known stack sizes from 16KB to 1MB+

### Tradeoffs
⚠️ **No preemption** - CPU-bound coroutine blocks its worker  
⚠️ **Fixed worker count** - must be set at startup  
⚠️ **Thread affinity** - coroutines can't migrate for load balancing  
⚠️ **Non-growable stacks** - Stack size fixed at spawn time (configurable 16KB-1MB+, not dynamically growable)
⚠️ **Unbounded pool** - pool grows during execution (freed only at shutdown)
⚠️ **Stack overflow detection** - Only works in debug builds (-O0), optimizations may bypass detection

## Example

```yo
open import "std";

main :: (fn() -> i32) {
  // Create 2 OS worker threads
  Concurrency.set_maximum_threads(2);
  
  ch := chan(i32);  // Unbuffered channel
  
  // Spawn 4 coroutines (distributed round-robin to 2 workers)
  async worker(1, ch);  // → Worker 0
  async worker(2, ch);  // → Worker 1
  async worker(3, ch);  // → Worker 0
  async worker(4, ch);  // → Worker 1
  
  // Main thread receives results
  i := 0;
  while i < 4, {
    value := <-(ch).unwrap();
    printf("Received: %d\n", value);
  };
  
  return 0;
};

worker :: (fn(id: i32, ch: Chan(i32)) -> Unit) {
  printf("Worker %d on thread %zu\n", id, Concurrency.get_thread_id());
  ch <- (id * 10);
};
```

**Output** (order non-deterministic):
```
Worker 1 on thread 140123456789
Worker 2 on thread 140123456790
Worker 3 on thread 140123456789  // Same as Worker 1 (thread affinity)
Worker 4 on thread 140123456790  // Same as Worker 2 (thread affinity)
Received: 10
Received: 20
Received: 30
Received: 40
```

## Comparison with Go

| Feature | Yo | Go |
|---------|----|----|
| Threading Model | M:N (hybrid) | M:N |
| Coroutine Lib | llco v1.0 | Custom asm |
| Task Scheduling | Cooperative | Preemptive |
| Work Stealing | ❌ No (affinity) | ✅ Yes |
| Stack Size | Configurable 16KB-1MB+ | Growable 2KB→1GB |
| Stack Overflow Detection | ✅ Debug builds only | ✅ Always |
| Coroutine Pool | ✅ Yes (thread-local) | ✅ Yes (G pool) |
| CPU Affinity | ✅ Yes (thread-per-core) | ❌ No (GOMAXPROCS only) |
| Parallelism | OS thread pool | GOMAXPROCS |
| Channel Semantics | Unbuffered default | Same |
| Select Statement | ✅ Full support | ✅ Full support |
| GC Integration | BRC (per-thread) | Mark-sweep (STW) |

## Future Improvements

Potential enhancements (not yet implemented):
- [ ] Dynamic worker pool resizing
- [ ] Growable coroutine stacks (currently fixed at spawn but configurable)
- [ ] Configurable thread affinity assignments
- [ ] Coroutine priorities
- [ ] Preemptive scheduling (timer-based)
- [ ] Work stealing with ownership transfer
- [ ] Coroutine-local storage
- [ ] Better deadlock detection
- [ ] Async/await syntax sugar
- [ ] Randomized select case selection (fairness)
- [ ] Buffered channels as default (like Go)
- [ ] Stack overflow detection in release builds (currently debug only)