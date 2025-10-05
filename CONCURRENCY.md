# Concurrency Model

Yo implements a **hybrid M:N threading model** that combines OS-level parallelism with cooperative multitasking, similar to Go's goroutines but with some key differences.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Main Thread                        │
│  - Calls Concurrency.set_maximum_threads(N)         │
│  - Spawns N worker threads (OS threads)             │
│  - Can send/recv on channels (pthread blocking)     │
└─────────────────────────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        │                               │
┌───────▼──────────┐            ┌────────▼────────┐
│  Worker Thread 1 │            │ Worker Thread N │
│  (OS Thread)     │    ...     │  (OS Thread)    │
├──────────────────┤            ├─────────────────┤
│ Task Queue 1     │            │ Task Queue N    │
│  ┌────────────┐  │            │  ┌────────────┐ │
│  │ Task A     │  │            │  │ Task X     │ │
│  │ Task B     │  │            │  │ Task Y     │ │
│  │ Task C     │  │            │  │ Task Z     │ │
│  └────────────┘  │            │  └────────────┘ │
│                  │            │                 │
│ Cooperative      │            │ Cooperative     │
│ Scheduling       │            │ Scheduling      │
│ (setjmp/longjmp) │            │ (setjmp/longjmp)│
└──────────────────┘            └─────────────────┘
```

## Key Components

### 1. **Worker Threads (OS Threads)**
- Created via `Concurrency.set_maximum_threads(N)`
- Each worker is a real OS thread (pthread/Windows thread)
- Workers run independently and in parallel
- Each worker has its own task queue (thread affinity)

### 2. **Cooperative Tasks**
- Spawned with `async function(args)`
- Distributed round-robin to worker threads
- Run cooperatively within each worker using setjmp/longjmp
- Each task has its own 64KB stack
- Tasks voluntarily yield when blocking on channels

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
// Spawn a task on a worker thread (non-blocking)
async function(args...)

// Example:
async say("hello", 42, channel)
```

### Channels
```yo
// Create unbuffered channel (synchronous rendezvous)
ch := chan(Type)

// Create buffered channel with capacity
ch := chan(Type, capacity)

// Send value (blocks if unbuffered and no receiver)
ch <- value

// Receive value (blocks if no sender)
result := <-(ch)  // Returns Option(Type)
```

## Execution Model

### Task Lifecycle

1. **Spawn**: `async func()` creates a task and assigns it to a worker (round-robin)
2. **Schedule**: Worker dequeues task from its ready queue
3. **Execute**: Task runs cooperatively on its own stack
4. **Block**: Task blocks on channel → saves context → worker switches to next task
5. **Wake**: Channel operation completes → task moved back to ready queue
6. **Resume**: Worker restores task context → task continues execution
7. **Complete**: Task finishes → cleanup → worker fetches next task

### Cooperative Scheduling

Tasks cooperate within each worker thread:
- **No preemption** - tasks run until they voluntarily yield
- **Yields occur on**: channel send/recv operations
- **Context switching**: setjmp/longjmp with separate stacks
- **Fast switching**: no syscalls, just register/stack save/restore

### Parallelism

Workers run in parallel across CPU cores:
- **True parallelism** - multiple workers execute simultaneously
- **Independent queues** - no lock contention for task scheduling
- **Parallel channels** - tasks on different workers can communicate

## Channel Semantics

### Unbuffered Channels (Rendezvous)
```yo
ch := chan(i32)  // capacity = 0

// Sender blocks until receiver is ready
async ((fn()-> unit){ ch <- 42 })()  // Blocks in task context

// Receiver blocks until sender is ready
value := <-(ch)  // Blocks (pthread if main, cooperative if task)
```

### Buffered Channels
```yo
ch := chan(i32, 10)  // capacity = 10

// Sender blocks only if buffer is full
ch <- 42  // Non-blocking if buffer has space

// Receiver blocks only if buffer is empty
value := <-(ch)  // Non-blocking if buffer has data
```

### Cross-Thread Communication

Channels work across threads using hybrid synchronization:
- **Task → Task (same worker)**: Cooperative yielding
- **Task → Task (different worker)**: Global wakeup across workers
- **Task → Main Thread**: pthread condition variables
- **Main Thread → Task**: pthread signals + task wakeup

## Implementation Details

### Task Structure
```c
struct yo_task {
  void (*func)(void*);      // Task function
  void* data;                // Task arguments
  yo_task_state_t state;     // READY, RUNNING, BLOCKED, COMPLETED
  void* wait_channel;        // Channel blocking on (or NULL)
  jmp_buf context;           // Saved execution context
  char* stack;               // Separate 64KB stack
  size_t stack_size;
  bool context_initialized;  // Whether setjmp has been called
  yo_task_t* next;           // Queue linkage
};
```

### Worker Structure
```c
struct yo_worker_thread {
  pthread_t handle;           // OS thread handle
  pthread_t id;               // Thread ID
  bool active;
  yo_task_queue_t ready_queue;    // Tasks ready to run
  yo_task_queue_t blocked_queue;  // Tasks waiting on channels
  pthread_mutex_t queue_mutex;    // Protects queues
};
```

### Context Switching

**Task Bootstrap** (first run):
```c
1. Worker switches to task's stack
2. Calls __yo_task_bootstrap(task)
3. Bootstrap calls setjmp(task->context) → returns 0
4. Marks context_initialized = true
5. Executes task->func(task->data)
6. On completion: longjmp to worker context
```

**Task Resume** (after blocking):
```c
1. Worker calls longjmp(task->context, 1)
2. Task's setjmp returns 1 (resumed)
3. Task continues from where it blocked
4. Executes remaining code
5. On completion or re-block: longjmp to worker
```

**Critical**: `longjmp()` automatically restores the stack pointer from the saved context. No manual stack switching needed for resume!

## Synchronization

### Blocking Mechanisms

**Cooperative (Tasks)**:
- Save context with `setjmp()`
- Move task to blocked queue
- Switch to next ready task or return to worker
- On wakeup: move to ready queue, worker will resume

**OS-level (Main Thread)**:
- Use pthread condition variables
- `pthread_cond_wait()` on channels
- `pthread_cond_signal()` from tasks
- Allows main thread to block without spinning

### Wakeup Strategies

**Local Wakeup** (`__yo_task_wakeup_one`):
- Wakes one task from current worker's blocked queue
- Used when task wakes another task on same worker
- Fast: no cross-thread coordination

**Global Wakeup** (`__yo_task_wakeup_one_global`):
- Searches all workers' blocked queues
- Wakes first matching task found
- Used when main thread or non-task context wakes a task
- Slower: requires locking each worker's queue

## Memory Management & BRC

### Why Thread Affinity?

Yo uses **Biased Reference Counting** (BRC) for memory management:
- Each object has an "owner thread"
- Owner thread uses fast non-atomic operations
- Non-owner threads use slower atomic operations
- Object ownership can transfer but requires synchronization

**Thread affinity ensures**:
- Tasks stay on the thread that created their objects
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
✅ **Low overhead context switching** - setjmp/longjmp is fast  
✅ **No syscalls for task scheduling** - all in userspace  
✅ **True parallelism** - workers run on multiple cores  
✅ **Scalable** - per-worker queues eliminate contention  
✅ **Efficient memory** - shared thread stacks, not per-task OS stacks

### Tradeoffs
⚠️ **No preemption** - CPU-bound task blocks its worker  
⚠️ **Fixed worker count** - must be set at startup  
⚠️ **Thread affinity** - tasks can't migrate for load balancing  
⚠️ **Stack size limit** - 64KB per task (can be tuned)

## Example

```yo
open import "std"

main :: (fn() -> i32) {
  // Create 2 OS worker threads
  Concurrency.set_maximum_threads(2)
  
  ch := chan(i32)  // Unbuffered channel
  
  // Spawn 4 tasks (distributed round-robin to 2 workers)
  async worker(1, ch)  // → Worker 0
  async worker(2, ch)  // → Worker 1
  async worker(3, ch)  // → Worker 0
  async worker(4, ch)  // → Worker 1
  
  // Main thread receives results
  for i in 0..4 {
    value := <-(ch).unwrap()
    printf("Received: %d\n", value)
  }
  
  return 0
}

worker :: (fn(id: i32, ch: Chan(i32)) -> Unit) {
  printf("Worker %d on thread %zu\n", id, Concurrency.get_thread_id())
  ch <- (id * 10)
}
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
| Task Scheduling | Cooperative | Preemptive |
| Work Stealing | ❌ No (affinity) | ✅ Yes |
| Context Switch | setjmp/longjmp | Custom asm |
| Stack Size | Fixed 64KB | Growable 2KB→1GB |
| Parallelism | OS thread pool | GOMAXPROCS |
| Channel Semantics | Rendezvous | Buffered default |
| GC Integration | BRC (per-thread) | Mark-sweep (STW) |

## Future Improvements

Potential enhancements (not yet implemented):
- [ ] Dynamic worker pool resizing
- [ ] Growable task stacks
- [ ] Task priorities
- [ ] Preemptive scheduling (timer-based)
- [ ] Work stealing with ownership transfer
- [ ] Task-local storage
- [ ] Better deadlock detection
- [ ] Async/await syntax sugar