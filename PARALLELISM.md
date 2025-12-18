# Parallelism - Isolated Multi-Threaded Execution for Yo

## Philosophy

Yo uses **isolated spawn** for parallel execution across multiple CPU cores. Each spawned Worker runs on its own thread. Shared memory is allowed, but only for values that the type system marks as `Send` (see "Sendable Types" below). GC-managed reference values (for example `object` and `Dyn`, which use non-atomic reference counting) and any value types that contain them are **not** `Send` and therefore cannot be shared across threads. Message passing remains the recommended and safest communication mechanism.

This is similar to:

- **JavaScript Web Workers** - isolated threads, postMessage communication
- **Erlang/Elixir Processes** - actor model with message passing
- **Go Goroutines with Channels** - but with enforced isolation for GC values

**Key Insight**: By restricting cross-thread sharing to values that are provably `Send`, Yo keeps the model simple while allowing efficient sharing where safe:

- **Reduced data races**: GC-managed reference values are not `Send`, so they cannot be shared across threads and therefore cannot introduce cross-thread data races.
- **Type-level sendability**: The `Send` module/trait determines which types may cross thread boundaries; only `Send` types may be shared or moved between Workers.
- **No atomic RC for thread-local objects**: Reference-counted objects that remain thread-local continue to use non-atomic RC and a thread-local cycle collector.
- **Simpler ownership analysis**: `Send` checks combined with message passing keep cross-thread ownership reasoning straightforward.

```rust
// Spawn runs on a DIFFERENT thread, returns Worker handle immediately
worker := Worker(i32, boolean).spawn((child) -> async {
  match(await child.try_recv(),
    .Some(msg) => {
      // Received message from parent
      await child.try_send(true);  // Send back to parent
    },
    .None => /* Parent closed */,
  );
});

// Communicate with child
match(await worker.try_send(42),
  .Some(()) => {
    // Sent successfully
    match(await worker.try_recv(),
      .Some(result) => /* Got result from child */,
      .None => /* Child closed */,
    );
  },
  .None => /* Child closed */,
);
```

## Concurrency vs Parallelism

| Concept         | Mechanism     | Description                                |
| --------------- | ------------- | ------------------------------------------ |
| **Concurrency** | `async/await` | Multiple tasks interleaved on ONE thread   |
| **Parallelism** | `spawn`       | Multiple tasks running on SEPARATE threads |

See `ASYNC_AWAIT.md` for single-threaded concurrency.

## Design Principles

### 1. Complete Isolation

Each spawned Worker:

- Runs on its own OS thread (from thread pool)
- Has its own heap for GC-managed values
- Has its own reference counting for objects (non-atomic)
- Has its own cycle collector
- Cannot directly access the parent's stack variables; cross-thread interaction happens via message passing or by sharing values that are `Send`.

```yo
// Parent thread
x := 42;
obj := SomeObject();

worker := Worker(i32, unit).spawn((child) -> async {
  // ❌ CANNOT access parent's stack variables or non-Send objects here
  // (GC-managed `object`/`Dyn` values are not Send and remain thread-local)

  // ✅ Can receive/send Sendable values
  match(await child.try_recv(),
    .Some(value) => /* Received copy/move of a Sendable value */,
    .None => /* Parent closed */,
  );
});

await worker.try_send(x);  // Sending `x` (primitive `i32`) is allowed because it's Send
// await worker.try_send(obj);  // ❌ ERROR: Cannot send reference type `obj` (not Send)
```

### 2. Sendable Types

Only types that implement the `Send` contract may be shared or sent between threads. In practice this means:

- **Sendable**: primitives (`i32`, `u64`, `boolean`, etc.), value structs/tuples/enums composed entirely of `Send` fields, and other types explicitly marked `Send`.
- **Not Sendable**: GC-managed reference types like `object(...)` and `Dyn`, closures that capture non-Send references, and any value type that contains non-Send fields.

Example:

```yo
// ✅ Sendable value types
Point :: struct(x: i32, y: i32);
Color :: enum(Red, Green, Blue);

worker := Worker(Point, Color).spawn((child) -> async {
  match(await child.try_recv(),
    .Some(point) => {
      // Received a Sendable Point
      await child.try_send(.Blue);  // Send Color value back
    },
    .None => /* Parent closed */,
  );
});

// ❌ Non-Sendable (GC-managed) reference types
Node :: object(value: i32, next: Option(Node));
// Worker(Node, unit)  // ERROR: Node is not Send
```

The language uses a `Send` module/trait to decide sendability. For example the pointer type is declared `Send` only when its pointee is `Send`:

```
impl(forall(T : Type), where(T <: Send), *(T), Send());
```

This means `*(i32)` is `Send` (because `i32` is `Send`), but `*(Box(i32))` is not `Send` if `Box(i32)` is not `Send`.

### 3. Thread Pool with Affinity

Spawned workers use a **thread pool** with **thread affinity**:

- Fixed number of OS threads (configurable)
- Each worker is assigned to an OS thread and stays there
- No work stealing (worker never moves to another thread)
- OS threads are reused for efficiency

Why thread affinity?

- Each thread has its own cycle collector
- Moving tasks would require cross-thread GC coordination
- Simpler, safer, more predictable

```
┌────────────────────────────────────────────────────────────────┐
│                         Thread Pool                            │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ OS Thread 0  │  │ OS Thread 1  │  │ OS Thread 2  │  ...     │
│  │ (pinned)     │  │ (pinned)     │  │ (pinned)     │          │
│  ├──────────────┤  ├──────────────┤  ├──────────────┤          │
│  │ Worker A     │  │ Worker B     │  │ Worker C     │          │
│  │ Worker D     │  │ Worker E     │  │ Worker F     │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                │
│  Each Worker stays on its assigned OS thread forever           │
└────────────────────────────────────────────────────────────────┘
```

## Worker API

### Worker Type

```rust
// Worker is a generic type with SendType and ReceiveType
// The same Worker type is used by both parent and child (with flipped type parameters)
// For parent: Worker(SendType, ReceiveType) - sends SendType, receives ReceiveType
// For child: receives Worker(ReceiveType, SendType) as parameter - sends ReceiveType, receives SendType
Worker :: (fn(compt(SendType): Type, compt(ReceiveType): Type) -> compt(Type)) {
  return object(
    // Internal fields (not directly accessible)
    // - thread_handle: OS thread handle
    // - send_channel: Channel(SendType)
    // - recv_channel: Channel(ReceiveType)
    // - other_alive: _Atomic bool (tracks if the other end is alive)
    //   * Parent tracks child's liveness (updated by child on exit)
    //   * Child tracks parent's liveness (updated by parent on exit/kill)

    // Spawn a new isolated worker (returns immediately, no await needed)
    // The child function receives a Worker with flipped type parameters
    spawn :: (fn(child: fn(Worker(ReceiveType, SendType)) -> Future(unit)) -> Self),

    // Spawn a new worker on a dedicated OS thread (not from thread pool) and not shared with others
    spawn_local :: (fn(child: fn(Worker(ReceiveType, SendType)) -> Future(unit)) -> Self),

    // Try to send a message to the other end
    // Blocks until: (1) message sent, OR (2) other end closed
    // Returns Some(()) if sent, None if other end closed
    try_send :: (fn(self: Self, msg: SendType) -> Future(Option(unit))),

    // Try to receive a message from the other end
    // Blocks until: (1) message received, OR (2) other end closed
    // Returns Some(value) if received, None if other end closed
    try_recv :: (fn(self: Self) -> Future(Option(ReceiveType))),

    // Check if the other end is still alive (non-blocking)
    is_alive :: (fn(self: Self) -> boolean),

    // Wait for the worker to complete (blocks until child exits)
    join :: (fn(self: Self) -> Future(unit)),

    // Kill the worker (updates child's parent_alive flag)
    kill :: (fn(self: Self) -> unit),
  );
};
```

### Basic Usage

```rust
main :: (fn() -> unit) {
  async {
    // Spawn a worker that receives i32 and sends boolean (returns immediately)
    worker := Worker(i32, boolean).spawn(
      (child) -> async {
        // Child's perspective: receives i32, sends boolean
        match(await child.try_recv(),
          .Some(value) => {
            printf("Child received: %d\n", value);
            await child.try_send(value > 0);  // Send result back
          },
          .None => printf("Parent closed\n"),
        );
      }
    );

    // Parent sends i32, receives boolean
    match(await worker.try_send(42),
      .Some(()) => {
        match(await worker.try_recv(),
          .Some(result) => {
            printf("Parent received: %s\n", cond(result => "true", true => "false"));
          },
          .None => printf("Child closed\n"),
        );
      },
      .None => printf("Child closed\n"),
    );

    await worker.join();  // Wait for worker to finish
  };
};
```

### Multiple Messages

```rust
// Worker that processes multiple requests
worker_task :: (fn() -> Future(unit)) async {
  worker := Worker(Request, Response).spawn(
    (child) -> async {
      // Process requests until parent closes
      while runtval(true), {
        match(await child.try_recv(),
          .Some(request) => {
            response := process_request(request);
            await child.try_send(response);
          },
          .None => {
            // Parent closed, exit
            return ();
          },
        );
      };
    }
  );

  // Send multiple requests
  match(await worker.try_send(Request("query1")),
    .Some(()) => {
      match(await worker.try_recv(),
        .Some(r1) => /* Process r1 */,
        .None => /* Child closed */,
      );
    },
    .None => /* Child closed */,
  );

  match(await worker.try_send(Request("query2")),
    .Some(()) => {
      match(await worker.try_recv(),
        .Some(r2) => /* Process r2 */,
        .None => /* Child closed */,
      );
    },
    .None => /* Child closed */,
  );

  worker.kill();  // Done with worker
};
```

### Bidirectional Streaming

```rust
// Example: Pipeline processing
pipeline :: (fn() -> Future(unit)) async {
  // Stage 1: Generate numbers
  stage1 := Worker(unit, i32).spawn(
    (child) -> async {
      i := 0;
      while i < 100, {
        match(await child.try_send(i),
          .Some(()) => i = i + 1,
          .None => return (),  // Parent closed
        );
      };
    }
  );

  // Stage 2: Double numbers
  stage2 := Worker(i32, i32).spawn(
    (child) -> async {
      loop {
        match(await child.try_recv(),
          .Some(n) => {
            match(await child.try_send(n * 2),
              .Some(()) => (),
              .None => return (),  // Parent closed
            );
          },
          .None => return (),  // Parent closed
        );
      };
    }
  );

  // Connect pipeline
  while runtval(true), {
    match(await stage1.try_recv(),
      .Some(n) => {
        match(await stage2.try_send(n),
          .Some(()) => {
            match(await stage2.try_recv(),
              .Some(result) => printf("Result: %d\n", result),
              .None => break,
            );
          },
          .None => break,
        );
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
  pthread_t* threads;       // Array of OS threads
  size_t num_threads;       // Number of OS threads
  yo_worker_queue_t* queues;  // Per-OS-thread worker queues
} yo_thread_pool_t;

// Global thread pool (initialized once)
static yo_thread_pool_t* g_thread_pool = NULL;

// Initialize thread pool
void yo_init_thread_pool(size_t num_threads) {
  g_thread_pool = malloc(sizeof(yo_thread_pool_t));
  g_thread_pool->num_threads = num_threads;
  g_thread_pool->threads = malloc(num_threads * sizeof(pthread_t));
  g_thread_pool->queues = malloc(num_threads * sizeof(yo_worker_queue_t));

  for (size_t i = 0; i < num_threads; i++) {
    yo_worker_queue_init(&g_thread_pool->queues[i]);
    pthread_create(&g_thread_pool->threads[i], NULL, yo_os_thread_loop, (void*)i);
    // Set CPU affinity
    yo_set_thread_affinity(g_thread_pool->threads[i], i);
  }
}
```

### Worker Spawn

```c
// Spawn a new Worker on the thread pool
yo_worker_t* yo_worker_spawn(yo_worker_fn_t fn, void* closure) {
  yo_worker_t* worker = malloc(sizeof(yo_worker_t));

  // Create bidirectional channels
  worker->send_channel = yo_channel_create();
  worker->recv_channel = yo_channel_create();
  worker->is_alive = true;

  // Create child worker context
  yo_child_context_t* ctx = malloc(sizeof(yo_child_context_t));
  ctx->fn = fn;
  ctx->closure = closure;
  ctx->parent_send = worker->recv_channel;  // Child sends to parent's recv
  ctx->parent_recv = worker->send_channel;  // Child recvs from parent's send

  // Assign to OS thread (round-robin)
  static _Atomic size_t next_worker = 0;
  size_t worker_id = atomic_fetch_add(&next_worker, 1) % g_thread_pool->num_threads;

  // Enqueue to OS thread
  yo_worker_queue_push(&g_thread_pool->queues[worker_id], ctx);

  return worker;
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

### OS Thread Loop

```c
// OS thread main loop
void* yo_os_thread_loop(void* arg) {
  size_t worker_id = (size_t)arg;
  yo_worker_queue_t* queue = &g_thread_pool->queues[worker_id];

  while (true) {
    // Dequeue next Worker
    yo_child_context_t* ctx = yo_worker_queue_pop(queue);
    if (ctx == NULL) {
      // No workers, sleep briefly
      usleep(1000);  // 1ms
      continue;
    }

    // Run the Worker's async function
    // The Worker has its own event loop for async/await
    yo_run_async_task(ctx);

    // Worker completed, cleanup
    free(ctx);
  }

  return NULL;
```

## Memory Model

### Isolation Guarantees

Each spawned Worker has:

- **Separate heap for GC values**: All `object`/`Dyn` allocations are thread-local
- **Non-atomic RC**: Reference-counted objects use non-atomic operations
- **Thread-local GC**: Cycle collection happens independently per thread
- **Send-based sharing**: Only `Send` types can cross thread boundaries

This means:

- No data races on GC-managed values (they cannot be shared)
- `Send` trait determines what crosses threads (checked at compile time)
- No atomic overhead for thread-local objects
- No cross-thread GC coordination

### Value Serialization

When sending values between threads, they are **copied**:

```rust
Point :: struct(x: i32, y: i32);

worker := Worker(Point, unit).spawn((child) -> async {
  match(await child.try_recv(),
    .Some(p) => {
      // Receives COPY of Point (mutated here for child)
      mut_p := p;
      mut_p.x = 999;  // Modifies the copy, not the original
    },
    .None => (),
  );
});

original := Point(x: 1, y: 2);
await worker.try_send(original);  // Sends COPY
// original.x is still 1
```

For large value types, consider:

- Sending references to shared immutable data (if supported)
- Breaking work into smaller chunks
- Using shared memory regions (future feature)

## API Reference

### Parallelism Control

```rust
// Set the number of threads in pool
Thread.set_maximum_threads :: (fn(n: usize) -> unit);

// Get the number of hardware threads available
Thread.get_hardware_threads :: (fn() -> usize);

// Get current thread ID
Thread.get_thread_id :: (fn() -> usize);
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

| Aspect          | Yo (Isolated Spawn)    | Go (Shared Memory)          | Rust (Arc + Send)              |
| --------------- | ---------------------- | --------------------------- | ------------------------------ |
| Thread Safety   | ✅ Enforced by design  | ⚠️ Developer responsibility | ✅ Type system enforced        |
| Data Races      | ✅ Impossible          | ❌ Possible                 | ✅ Prevented by borrow checker |
| Complexity      | ✅ Simple              | ⚠️ Moderate                 | ❌ High (lifetimes, Send/Sync) |
| Overhead        | ⚠️ Copy on send        | ✅ Shared pointers          | ⚠️ Atomic RC                   |
| GC Coordination | ✅ None (thread-local) | ❌ Stop-the-world           | N/A                            |

## Examples

### Parallel Map

```rust
// Parallel map over array
parallel_map :: (fn(arr: Array(i32), f: fn(i32) -> i32) -> Future(Array(i32))) async {
  n := arr.len();
  num_workers := Thread.get_hardware_threads();
  chunk_size := (n + num_workers - 1) / num_workers;

  // Spawn workers
  workers := [];
  i := 0;
  while i < num_workers, {
    start := i * chunk_size;
    end := min(start + chunk_size, n);

    // Each worker receives array chunk, returns processed chunk
    worker := Worker(Array(i32), Array(i32)).spawn(
      (child) -> async {
        match(await child.try_recv(),
          .Some(chunk) => {
            result := chunk.map(f);  // f is captured by value
            await child.try_send(result);
          },
          .None => (),
        );
      }
    );

    // Send chunk to worker
    await worker.try_send(arr.slice(start, end));
    workers.push(worker);
    i = i + 1;
  };

  // Collect results
  result := [];
  i := 0;
  while i < workers.len(), {
    match(await workers[i].try_recv(),
      .Some(chunk) => result = result.concat(chunk),
      .None => (),
    );
    i = i + 1;
  };

  return result;
};
```

### Worker Pool Pattern

```rust
// Reusable worker pool
WorkerPool :: (fn(compt(Request): Type, compt(Response): Type) -> compt(Type)) {
  return object(
    workers: Array(Worker(Request, Response)),
    next: usize,

    create :: (fn(n: usize, handler: fn(Request) -> Response) -> Self) {
      workers := [];
      i := 0;
      while i < n, {
        worker := Worker(Request, Response).spawn(
          (child) -> async {
            loop {
              match(await child.try_recv(),
                .Some(req) => {
                  resp := handler(req);
                  await child.try_send(resp);
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

    submit :: (fn(self: mut Self, req: Request) -> Future(Option(Response))) async {
      worker := self.workers[self.next];
      self.next = (self.next + 1) % self.workers.len();
      match(await worker.try_send(req),
        .Some(()) => await worker.try_recv(),
        .None => .None,
      )
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

| Language/Framework       | UI Thread Model                                      |
| ------------------------ | ---------------------------------------------------- |
| **C# (WPF/WinForms)**    | Dedicated UI thread + ThreadPool for background work |
| **Swift (iOS/macOS)**    | Main thread for UI + GCD for background              |
| **JavaScript (Browser)** | Main thread for DOM + Web Workers for background     |
| **Java (Swing/Android)** | EDT/Main thread for UI + thread pool for background  |
| **Qt (C++)**             | Main thread for GUI + QThreadPool for background     |

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

      match(event,
        .ButtonClick => {
          // Spawn heavy work on background thread (from pool)
          worker := Worker(unit, String).spawn((child) -> async {
            result := expensive_computation();
            await child.try_send(result);
          });

          // Wait for result and update UI (we're on main thread!)
          match(await worker.try_recv(),
            .Some(result) => label.set_text(result),  // Safe - we're on main thread
            .None => (),
          );
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
// Background worker sends result via channel
worker := Worker(unit, UIUpdate).spawn((child) -> async {
  data := await fetch_from_network();
  await child.try_send(UIUpdate.SetLabel(data));  // Send to main thread
});

// Main thread receives and updates UI
async {
  loop {
    match(await worker.try_recv(),
      .Some(UIUpdate.SetLabel(text)) => label.set_text(text),
      .None => break,
    );
  };
};
```

### Thread Summary

| Thread             | Creation                    | Purpose            | Characteristics          |
| ------------------ | --------------------------- | ------------------ | ------------------------ |
| **Main Thread**    | OS creates at program start | UI, event loop     | Dedicated, not from pool |
| **Worker Threads** | Thread pool at startup      | Background compute | From pool, reused        |

## Summary

Yo's parallelism model provides:

1. ✅ **Send-based isolation** - GC-managed values cannot cross threads
2. ✅ **No data races on GC values** - enforced by type system
3. ✅ **Simple mental model** - message passing with `try_send`/`try_recv`
4. ✅ **`Send` trait** - compile-time check for thread safety
5. ✅ **Non-atomic RC** - thread-local objects use non-atomic operations
6. ✅ **Thread-local GC** - no stop-the-world pauses
7. ✅ **Thread pool** - efficient thread reuse
8. ✅ **CPU affinity** - optimal cache locality
9. ✅ **Cross-thread status tracking** - parent and child track each other's liveness

### Quick Reference

```yo
// Spawn isolated worker (returns immediately, no await)
worker := Worker(SendType, RecvType).spawn(
  (child) -> async {
    // Runs on separate thread
    match(await child.try_recv(),
      .Some(msg) => await child.try_send(result),
      .None => (),
    );
  }
);

// Communicate with worker
match(await worker.try_send(value),
  .Some(()) => {
    match(await worker.try_recv(),
      .Some(result) => /* Use result */,
      .None => /* Child closed */,
    );
  },
  .None => /* Child closed */,
);

// Wait for completion
await worker.join();

// Configure parallelism
Parallelism.set_num_workers(8);
```

### Key Principles

1. **Send-based sharing** - only `Send` types can cross thread boundaries
2. **Message passing** - primary way to communicate between Workers via `try_send`/`try_recv`
3. **GC values are thread-local** - `object`/`Dyn` types cannot be sent
4. **Thread pool** - fixed OS threads, Workers assigned round-robin
5. **Thread affinity** - Workers never move between OS threads
6. **Non-atomic RC** - no atomic operations for thread-local objects
7. **Thread-local GC** - each worker collects independently
8. **Cross-thread status** - parent and child track each other's liveness
