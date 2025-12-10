# Parallelism - Isolated Multi-Threaded Execution for Yo

## Philosophy

Yo uses **isolated spawn** for parallel execution across multiple CPU cores. Each spawned task runs on its own thread with **no shared memory** - communication happens exclusively through typed message passing.

This is similar to:
- **JavaScript Web Workers** - isolated threads, postMessage communication
- **Erlang/Elixir Processes** - actor model with message passing
- **Go Goroutines with Channels** - but with enforced isolation

**Key Insight**: By eliminating shared memory, we eliminate:
- Data races
- Need for `Send`/`Sync` traits
- Atomic reference counting
- Complex ownership analysis for threading

```yo
// Spawn runs on a DIFFERENT thread, completely isolated
task := Task(i32, boolean).spawn((parent) -> async {
  msg := await parent.recv();  // Receive from parent
  await parent.send(true);     // Send to parent
});

await task.send(42);           // Send to child
result := await task.recv();   // Receive from child (true)
```

## Concurrency vs Parallelism

| Concept | Mechanism | Description |
|---------|-----------|-------------|
| **Concurrency** | `async/await` | Multiple tasks interleaved on ONE thread |
| **Parallelism** | `spawn` | Multiple tasks running on SEPARATE threads |

See `ASYNC_AWAIT.md` for single-threaded concurrency.

## Design Principles

### 1. Complete Isolation

Each spawned task:
- Runs on its own OS thread (from thread pool)
- Has its own heap and memory
- Has its own reference counting (non-atomic)
- Has its own cycle collector
- **Cannot access parent's variables directly**

```yo
// Parent thread
x := 42;
obj := SomeObject();

task := Task(i32, unit).spawn((parent) -> async {
  // ❌ CANNOT access x or obj here!
  // This is a completely isolated thread
  
  // ✅ Can only communicate via messages
  value := await parent.recv();  // Receive copy of value
});

await task.send(x);  // Send COPY of x (value type)
// await task.send(obj);  // ❌ ERROR: Cannot send reference type!
```

### 2. Value Types Only

Only value types can be sent between threads:
- Primitives: `i32`, `u64`, `f32`, `boolean`, etc.
- Value structs: `struct(...)` with only value fields
- Tuples of value types
- Enums with value payloads

Reference types **cannot** be sent:
- `object(...)` - reference counted
- Closures capturing references
- Any type with internal pointers

```yo
// ✅ Value types - can be sent
Point :: struct(x: i32, y: i32);
Color :: enum(Red, Green, Blue);

task := Task(Point, Color).spawn((parent) -> async {
  point := await parent.recv();  // Receives copy of Point
  await parent.send(.Blue);      // Sends Color value
});

// ❌ Reference types - cannot be sent
Node :: object(value: i32, next: Option(Node));
// Task(Node, unit)  // ERROR: Node is reference type!
```

### 3. Thread Pool with Affinity

Spawned tasks use a **thread pool** with **thread affinity**:
- Fixed number of worker threads (configurable)
- Each task is assigned to a worker and stays there
- No work stealing (task never moves to another thread)
- Worker threads are reused for efficiency

Why thread affinity?
- Each thread has its own cycle collector
- Moving tasks would require cross-thread GC coordination
- Simpler, safer, more predictable

```
┌────────────────────────────────────────────────────┐
│                 Thread Pool                        │
│                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ Worker 0 │  │ Worker 1 │  │ Worker 2 │  ...     │
│  │ (pinned) │  │ (pinned) │  │ (pinned) │          │
│  ├──────────┤  ├──────────┤  ├──────────┤          │
│  │ Task A   │  │ Task B   │  │ Task C   │          │
│  │ Task D   │  │ Task E   │  │ Task F   │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                    │
│  Each task stays on its assigned worker forever    │
└────────────────────────────────────────────────────┘
```

## Task API

### Task Type

```yo
// Task is a generic type with SendType and ReceiveType
// SendType: Type of messages parent sends TO child
// ReceiveType: Type of messages parent receives FROM child
Task :: (fn(compt(SendType): Type, compt(ReceiveType): Type) -> compt(Type)) {
  return object(
    // Internal fields (not directly accessible)
    // - thread_handle: OS thread handle
    // - send_channel: Channel(SendType)
    // - recv_channel: Channel(ReceiveType)
    // - is_alive: boolean
    
    // Spawn a new isolated task
    // This is a regular function, not closure, so no captured variables.
    spawn :: (fn(body: Fn(Task(ReceiveType, SendType)) -> Future(unit)) -> Future(Self)),

    // Spawn a dedicated local task (not from thread pool)
    spawn_local :: (fn(body: Fn(Task(ReceiveType, SendType)) -> unit) -> Future(Self)),
    
    // Send a message to the other end (blocks if buffer full)
    send :: (fn(self: Self, msg: SendType) -> Future(unit)),
    
    // Receive a message from the other end (blocks if buffer empty)
    recv :: (fn(self: Self) -> Future(ReceiveType)),
    
    // Try to receive without blocking
    try_recv :: (fn(self: Self) -> Future(Option(ReceiveType))),
    
    // Check if the other end is still alive
    is_alive :: (fn(self: Self) -> boolean),
    
    // Wait for the task to complete
    join :: (fn(self: Self) -> Future(unit)),
    
    // Kill the task (if still running)
    kill :: (fn(self: Self) -> unit),
  );
};
```

### Basic Usage

```yo
main :: (fn() -> unit) {
  async {
    // Spawn a task that receives i32 and sends boolean
    task := await Task(i32, boolean).spawn(
      (parent) -> async {
        // Child's perspective: receives i32, sends boolean
        value := await parent.recv();  // Blocks until message arrives
        printf("Child received: %d\n", value);
        
        await parent.send(value > 0);  // Send result back
      }
    );
    
    // Parent sends i32, receives boolean
    await task.send(42);
    result := await task.recv();  // Blocks until child sends
    printf("Parent received: %s\n", cond(result => "true", true => "false"));
    
    await task.join();  // Wait for task to finish
  };
};
```

### Multiple Messages

```yo
// Worker that processes multiple requests
worker_task :: (fn() -> Future(unit)) async {
  task := await Task(Request, Response).spawn(
    (parent) -> async {
      // Process requests until parent closes
      while runtval(true), {
        match await parent.try_recv(), (
          .Some(request) => {
            response := process_request(request);
            await parent.send(response);
          },
          .None => {
            // Channel closed, exit
            return ();
          },
        );
      };
    }
  );
  
  // Send multiple requests
  await task.send(Request("query1"));
  r1 := await task.recv();
  
  await task.send(Request("query2"));
  r2 := await task.recv();
  
  task.kill();  // Done with worker
};
```

### Bidirectional Streaming

```yo
// Example: Pipeline processing
pipeline :: (fn() -> Future(unit)) async {
  // Stage 1: Generate numbers
  stage1 := await Task(unit, i32).spawn(
    (parent) -> async {
      i := 0;
      while i < 100, {
        await parent.send(i);
        i = i + 1;
      };
    }
  );
  
  // Stage 2: Double numbers
  stage2 := await Task(i32, i32).spawn(
    fn(parent) -> async {
      loop {
        match await parent.try_recv(), (
          .Some(n) => await parent.send(n * 2),
          .None => return (),
        );
      };
    }
  );
  
  // Connect pipeline
  while runtval(true), {
    match await stage1.try_recv(), (
      .Some(n) => {
        await stage2.send(n);
        result := await stage2.recv();
        printf("Result: %d\n", result);
      },
      .None => break,
    );
  };
};
```

## Implementation

### Thread Pool

```c
// Thread pool structure
typedef struct {
  pthread_t* threads;       // Array of worker threads
  size_t num_threads;       // Number of workers
  yo_task_queue_t* queues;  // Per-worker task queues
} yo_thread_pool_t;

// Global thread pool (initialized once)
static yo_thread_pool_t* g_thread_pool = NULL;

// Initialize thread pool
void yo_init_thread_pool(size_t num_threads) {
  g_thread_pool = malloc(sizeof(yo_thread_pool_t));
  g_thread_pool->num_threads = num_threads;
  g_thread_pool->threads = malloc(num_threads * sizeof(pthread_t));
  g_thread_pool->queues = malloc(num_threads * sizeof(yo_task_queue_t));
  
  for (size_t i = 0; i < num_threads; i++) {
    yo_task_queue_init(&g_thread_pool->queues[i]);
    pthread_create(&g_thread_pool->threads[i], NULL, yo_worker_loop, (void*)i);
    // Set CPU affinity
    yo_set_thread_affinity(g_thread_pool->threads[i], i);
  }
}
```

### Task Spawn

```c
// Spawn a new task on the thread pool
yo_task_t* yo_task_spawn(yo_task_fn_t fn, void* closure) {
  yo_task_t* task = malloc(sizeof(yo_task_t));
  
  // Create bidirectional channels
  task->send_channel = yo_channel_create();
  task->recv_channel = yo_channel_create();
  task->is_alive = true;
  
  // Create child task context
  yo_child_context_t* ctx = malloc(sizeof(yo_child_context_t));
  ctx->fn = fn;
  ctx->closure = closure;
  ctx->parent_send = task->recv_channel;  // Child sends to parent's recv
  ctx->parent_recv = task->send_channel;  // Child recvs from parent's send
  
  // Assign to worker (round-robin)
  static _Atomic size_t next_worker = 0;
  size_t worker_id = atomic_fetch_add(&next_worker, 1) % g_thread_pool->num_threads;
  
  // Enqueue to worker
  yo_task_queue_push(&g_thread_pool->queues[worker_id], ctx);
  
  return task;
}
```

### Channel Implementation

```c
// Lock-free MPSC channel (multiple producer, single consumer)
typedef struct {
  _Atomic void* buffer[CHANNEL_SIZE];
  _Atomic size_t head;
  _Atomic size_t tail;
  pthread_mutex_t mutex;
  pthread_cond_t not_empty;
  pthread_cond_t not_full;
  bool closed;
} yo_channel_t;

// Send message (blocks if full)
void yo_channel_send(yo_channel_t* ch, void* msg) {
  pthread_mutex_lock(&ch->mutex);
  while (channel_is_full(ch) && !ch->closed) {
    pthread_cond_wait(&ch->not_full, &ch->mutex);
  }
  if (!ch->closed) {
    ch->buffer[ch->tail % CHANNEL_SIZE] = msg;
    ch->tail++;
    pthread_cond_signal(&ch->not_empty);
  }
  pthread_mutex_unlock(&ch->mutex);
}

// Receive message (blocks if empty)
void* yo_channel_recv(yo_channel_t* ch) {
  pthread_mutex_lock(&ch->mutex);
  while (channel_is_empty(ch) && !ch->closed) {
    pthread_cond_wait(&ch->not_empty, &ch->mutex);
  }
  void* msg = NULL;
  if (!channel_is_empty(ch)) {
    msg = ch->buffer[ch->head % CHANNEL_SIZE];
    ch->head++;
    pthread_cond_signal(&ch->not_full);
  }
  pthread_mutex_unlock(&ch->mutex);
  return msg;
}
```

### Worker Loop

```c
// Worker thread main loop
void* yo_worker_loop(void* arg) {
  size_t worker_id = (size_t)arg;
  yo_task_queue_t* queue = &g_thread_pool->queues[worker_id];
  
  while (true) {
    // Dequeue next task
    yo_child_context_t* ctx = yo_task_queue_pop(queue);
    if (ctx == NULL) {
      // No tasks, sleep briefly
      usleep(1000);  // 1ms
      continue;
    }
    
    // Run the task's async function
    // The task has its own event loop for async/await
    yo_run_async_task(ctx);
    
    // Task completed, cleanup
    free(ctx);
  }
  
  return NULL;
}
```

## Memory Model

### Isolation Guarantees

Each spawned task has:
- **Separate heap**: All allocations are thread-local
- **Non-atomic RC**: No need for atomic operations
- **Thread-local GC**: Cycle collection happens independently
- **No shared state**: Only message passing

This means:
- No data races (nothing shared)
- No need for `Send`/`Sync` traits (values are copied)
- No atomic overhead (single-threaded within each task)
- No cross-thread GC coordination

### Value Serialization

When sending values between threads, they are **copied**:

```yo
Point :: struct(x: i32, y: i32);

task := await Task(Point, unit).spawn((parent) -> async {
  p := await parent.recv();  // Receives COPY of Point
  p.x = 999;  // Modifies the copy, not the original
});

original := Point(x: 1, y: 2);
await task.send(original);  // Sends COPY
// original.x is still 1
```

For large value types, consider:
- Sending references to shared immutable data (if supported)
- Breaking work into smaller chunks
- Using shared memory regions (future feature)

## API Reference

### Parallelism Control

```yo
// Set the number of worker threads (default: hardware thread count)
Parallelism.set_num_workers :: (fn(n: usize) -> unit);

// Get the current number of worker threads
Parallelism.get_num_workers :: (fn() -> usize);

// Get current worker ID (0 to num_workers-1)
Parallelism.get_worker_id :: (fn() -> usize);
```

### Task Methods

```yo
Task(SendType, ReceiveType) :: object(
  // Spawn a new task (returns Future that resolves to Task handle)
  spawn :: (fn(body: Fn(Task(ReceiveType, SendType)) -> Future(unit)) -> Future(Self)),
  
  // Send message to child (blocks if channel full)
  send :: (fn(self: Self, msg: SendType) -> Future(unit)),
  
  // Receive message from child (blocks if channel empty)
  recv :: (fn(self: Self) -> Future(ReceiveType)),
  
  // Try to receive without blocking
  try_recv :: (fn(self: Self) -> Future(Option(ReceiveType))),
  
  // Check if child is still running
  is_alive :: (fn(self: Self) -> boolean),
  
  // Wait for child to complete
  join :: (fn(self: Self) -> Future(unit)),
  
  // Terminate child (if running)
  kill :: (fn(self: Self) -> unit),
);
```

## Performance Characteristics

### Thread Pool

- Fixed number of OS threads (no thread creation overhead per spawn)
- CPU affinity for cache locality
- Minimal context switching (tasks complete before yielding thread)

### Message Passing

- Lock-based channels (pthread mutex + condvar)
- Bounded buffer (configurable size)
- Copy semantics (values are serialized/deserialized)

### Comparison

| Aspect | Yo (Isolated Spawn) | Go (Shared Memory) | Rust (Arc + Send) |
|--------|---------------------|--------------------|--------------------|
| Thread Safety | ✅ Enforced by design | ⚠️ Developer responsibility | ✅ Type system enforced |
| Data Races | ✅ Impossible | ❌ Possible | ✅ Prevented by borrow checker |
| Complexity | ✅ Simple | ⚠️ Moderate | ❌ High (lifetimes, Send/Sync) |
| Overhead | ⚠️ Copy on send | ✅ Shared pointers | ⚠️ Atomic RC |
| GC Coordination | ✅ None (thread-local) | ❌ Stop-the-world | N/A |

## Examples

### Parallel Map

```yo
// Parallel map over array
parallel_map :: (fn(arr: Array(i32), f: Fn(i32) -> i32) -> Future(Array(i32))) async {
  n := arr.len();
  num_workers := Parallelism.get_num_workers();
  chunk_size := (n + num_workers - 1) / num_workers;
  
  // Spawn workers
  tasks := [];
  i := 0;
  while i < num_workers, {
    start := i * chunk_size;
    end := min(start + chunk_size, n);
    
    // Each task receives array chunk, returns processed chunk
    task := await Task(Array(i32), Array(i32)).spawn(
      (parent) -> async {
        chunk := await parent.recv();
        result := chunk.map(f);  // f is captured by value
        await parent.send(result);
      }
    );
    
    // Send chunk to worker
    await task.send(arr.slice(start, end));
    tasks.push(task);
    i = i + 1;
  };
  
  // Collect results
  result := [];
  i := 0;
  while i < tasks.len(), {
    chunk := await tasks[i].recv();
    result = result.concat(chunk);
    i = i + 1;
  };
  
  return result;
};
```

### Worker Pool Pattern

```yo
// Reusable worker pool
WorkerPool :: (fn(compt(Request): Type, compt(Response): Type) -> compt(Type)) {
  return object(
    workers: Array(Task(Request, Response)),
    next: usize,
    
    create :: (fn(n: usize, handler: Fn(Request) -> Response) -> Future(Self)) async {
      workers := [];
      i := 0;
      while i < n, {
        worker := await Task(Request, Response).spawn(
          (parent) -> async {
            loop {
              match await parent.try_recv(), (
                .Some(req) => {
                  resp := handler(req);
                  await parent.send(resp);
                },
                .None => return (),
              );
            };
          }
        );
        workers.push(worker);
        i = i + 1;
      };
      return Self(workers: workers, next: 0);
    },
    
    submit :: (fn(self: mut Self, req: Request) -> Future(Response)) async {
      worker := self.workers[self.next];
      self.next = (self.next + 1) % self.workers.len();
      await worker.send(req);
      return await worker.recv();
    },
    
    shutdown :: (fn(self: Self) -> unit) {
      i := 0;
      while i < self.workers.len(), {
        self.workers[i].kill();
        i = i + 1;
      };
    },
  );
};
```
## Main Thread and UI

### Dedicated Main Thread

The `main()` function runs on a **dedicated OS thread** - not from the thread pool. This is important for:

1. **UI Applications**: GUI toolkits (Win32, Cocoa, GTK, etc.) require all UI operations on a single "main" thread
2. **OS Event Loop**: The main thread can run an event loop to receive OS messages (mouse, keyboard, window events)
3. **Thread Safety**: UI frameworks are NOT thread-safe - accessing UI from other threads causes crashes

### How Other Languages Handle This

| Language/Framework | UI Thread Model |
|-------------------|-----------------|
| **C# (WPF/WinForms)** | Dedicated UI thread + ThreadPool for background work |
| **Swift (iOS/macOS)** | Main thread for UI + GCD for background |
| **JavaScript (Browser)** | Main thread for DOM + Web Workers for background |
| **Java (Swing/Android)** | EDT/Main thread for UI + thread pool for background |
| **Qt (C++)** | Main thread for GUI + QThreadPool for background |

All use the same pattern: **dedicated main thread for UI, thread pool for background work**.

### Yo's Approach

```yo
main :: (fn() -> unit) {
  // We're on the dedicated main thread (NOT from thread pool)
  window := Window.create("My App", 800, 600);
  
  async {
    // This event loop runs on main thread (safe for UI)
    while window.is_open(), {
      event := await window.poll_event();
      
      match event, (
        .ButtonClick => {
          // Spawn heavy work on background thread (from pool)
          task := Task(unit, String).spawn((parent) -> async {
            result := expensive_computation();
            await parent.send(result);
          });
          
          // Wait for result and update UI (we're on main thread!)
          result := await task.recv();
          label.set_text(result);  // Safe - we're on main thread
        },
        .Close => window.close(),
      );
    };
  };
};
```

### Dispatching to Main Thread

When background tasks need to update UI, they send messages back:

```yo
// Background task sends result via channel
task := Task(unit, UIUpdate).spawn((parent) -> async {
  data := await fetch_from_network();
  await parent.send(UIUpdate.SetLabel(data));  // Send to main thread
});

// Main thread receives and updates UI
async {
  while runtval(true), {
    match await task.try_recv(), (
      .Some(UIUpdate.SetLabel(text)) => label.set_text(text),
      .None => break,
    );
  };
};
```

### Thread Summary

| Thread | Creation | Purpose | Characteristics |
|--------|----------|---------|-----------------|
| **Main Thread** | OS creates at program start | UI, event loop | Dedicated, not from pool |
| **Worker Threads** | Thread pool at startup | Background compute | From pool, reused |

## Summary

Yo's parallelism model provides:

1. ✅ **Complete isolation** - no shared memory between threads
2. ✅ **No data races** - impossible by design
3. ✅ **Simple mental model** - just message passing
4. ✅ **No Send/Sync traits** - values are copied
5. ✅ **Non-atomic RC** - each thread has its own heap
6. ✅ **Thread-local GC** - no stop-the-world pauses
7. ✅ **Thread pool** - efficient thread reuse
8. ✅ **CPU affinity** - optimal cache locality

### Quick Reference

```yo
// Spawn isolated task
task := await Task(SendType, RecvType).spawn(
  (parent) -> async {
    // Runs on separate thread
    msg := await parent.recv();
    await parent.send(result);
  }
);

// Communicate with task
await task.send(value);
result := await task.recv();

// Wait for completion
await task.join();

// Configure parallelism
Parallelism.set_num_workers(8);
```

### Key Principles

1. **Isolation** - each task has its own heap, no sharing
2. **Message passing** - only way to communicate between tasks
3. **Value types only** - reference types cannot be sent
4. **Thread pool** - fixed workers, tasks assigned round-robin
5. **Thread affinity** - tasks never move between workers
6. **Non-atomic** - no atomic operations needed within a task
7. **Thread-local GC** - each worker collects independently
