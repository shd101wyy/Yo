# Parallelism - Multi-Threaded Execution for Yo

## Philosophy

Yo provides two mechanisms for parallel execution:

1. **Thread** - A dedicated OS thread (wrapper around pthread)
2. **Worker** - A task that runs on a thread pool with thread affinity

Communication between threads is done via **Channel** (implemented separately).

This is similar to:

- **Go**: goroutines (Worker) + channels
- **Rust**: std::thread (Thread) + mpsc channels
- **Java**: Thread + ExecutorService (Worker) + BlockingQueue

**Key Insight**: By separating execution (Thread/Worker) from communication (Channel), we get a simpler and more flexible design.

## Concurrency vs Parallelism

| Concept         | Mechanism         | Description                                |
| --------------- | ----------------- | ------------------------------------------ |
| **Concurrency** | `async/await`     | Multiple tasks interleaved on ONE thread   |
| **Parallelism** | `Thread`/`Worker` | Multiple tasks running on SEPARATE threads |

See `ASYNC_AWAIT.md` for single-threaded concurrency.

## Thread - Dedicated OS Thread

`Thread` is a simple wrapper around OS threads (pthread on Unix, Windows threads on Windows).

### API

```rust
Thread :: struct(
  handle : __yo_thread_t,

  // Spawn a new OS thread running the given function
  // The function must be Send (no captured non-Send references)
  spawn :: (fn(f : Impl(Fn() -> unit, Send)) -> Thread),

  // Wait for the thread to complete (blocking)
  join :: (fn(self : Thread) -> unit),

  // Get current thread ID
  get_id :: (fn() -> usize),
);
```

### Usage

```rust
// Spawn a dedicated thread
thread := Thread.spawn(() => {
  printf("Hello from thread %zu\n", Thread.get_id());
  // Do work...
});

// Wait for completion
thread.join();
```

### When to Use Thread

- Long-running background tasks
- Tasks that need a dedicated OS thread (e.g., blocking I/O)
- UI applications (main thread + worker threads)
- When you need explicit control over thread lifecycle

## Worker - Thread Pool Task

`Worker` spawns tasks on a **thread pool** with **thread affinity**. Each task stays on its assigned OS thread (no work stealing).

### API

```rust
Worker :: impl {
  // Spawn a task on the thread pool
  // Returns immediately, task runs in background
  spawn :: (fn(f : Impl(Fn() -> unit, Send)) -> unit)(...);

  // Configure thread pool (call before first spawn)
  set_num_threads :: (fn(n : usize) -> unit)(...),

  // Get number of threads in pool (default: hardware threads)
  get_num_threads :: (fn() -> usize)(...);

  export spawn, set_num_threads, get_num_threads;
};
```

### Usage

```rust
// Spawn many tasks on thread pool
for i in range(0, 100), {
  Worker.spawn(() => {
    // Each task runs on a thread from the pool
    // with thread affinity (stays on same OS thread)
    do_work(i);
  });
};
```

### Thread Pool Design

```
┌────────────────────────────────────────────────────────────────┐
│                         Thread Pool                            │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ OS Thread 0  │  │ OS Thread 1  │  │ OS Thread 2  │  ...     │
│  │ (CPU 0)      │  │ (CPU 1)      │  │ (CPU 2)      │          │
│  ├──────────────┤  ├──────────────┤  ├──────────────┤          │
│  │ Task Queue   │  │ Task Queue   │  │ Task Queue   │          │
│  │ [A, D, G]    │  │ [B, E, H]    │  │ [C, F, I]    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                │
│  - Thread-per-core: one OS thread per CPU core                 │
│  - Thread affinity: tasks stay on assigned thread              │
│  - No work stealing: predictable, cache-friendly               │
└────────────────────────────────────────────────────────────────┘
```

### When to Use Worker

- Many short-lived tasks
- CPU-bound parallel work
- When you don't need to wait for individual tasks
- Task parallelism (map-reduce style)

## Channel - Inter-Thread Communication (Future)

Channels will be implemented separately to enable communication between threads/workers.

```rust
// Future API (not yet implemented)
Channel :: (fn(comptime(T) : Type) -> comptime(Type)) {
  object(
    send :: (fn(self : Self, value : T) -> Result(unit, T)),
    recv :: (fn(self : Self) -> Result(T, unit)),
    close :: (fn(self : Self) -> unit),
  )
};

// Create a channel pair (sender, receiver)
(tx, rx) := Channel(i32).create();

// Producer thread
Thread.spawn(() => {
  tx.send(42);
  tx.close();
});

// Consumer
match rx.recv(), {
  .Ok(value) => printf("Got %d\n", value),
  .Err(()) => printf("Channel closed\n"),
};
```

## Sendable Types

Only types that implement `Send` can cross thread boundaries:

- **Sendable**: primitives (`i32`, `bool`, etc.), value structs composed of Send fields
- **Not Sendable**: `object(...)`, `Dyn`, closures capturing non-Send values

```rust
// ✅ Sendable
Point :: struct(x: i32, y: i32);
Thread.spawn(() => {
  p := Point(1, 2);  // OK: created inside thread
});

// ❌ Not Sendable
Node :: object(value: i32);
node := Node(42);
Thread.spawn(() => {
  // ERROR: Cannot capture `node` (object is not Send)
  // node.value;
});
```

## Memory Model

### Thread-Local GC

Each OS thread has:

- **Separate heap**: GC-managed allocations are thread-local
- **Non-atomic RC**: Reference counting uses non-atomic operations
- **Thread-local cycle collector**: GC runs independently per thread

This means:

- No data races on GC-managed values (they can't be shared)
- No atomic overhead for reference counting
- No stop-the-world GC pauses

## Comparison: Thread vs Worker

| Aspect          | Thread                   | Worker                     |
| --------------- | ------------------------ | -------------------------- |
| OS Thread       | Dedicated (1:1)          | Shared (thread pool)       |
| Lifecycle       | Explicit (join/kill)     | Fire-and-forget            |
| Overhead        | Higher (thread creation) | Lower (reuses threads)     |
| Use Case        | Long-running tasks       | Short-lived tasks          |
| Thread Affinity | N/A                      | Yes (task stays on thread) |

## Summary

| Component   | Purpose                | API                     |
| ----------- | ---------------------- | ----------------------- |
| **Thread**  | Dedicated OS thread    | `spawn`, `join`, `kill` |
| **Worker**  | Thread pool task       | `spawn`                 |
| **Channel** | Communication (future) | `send`, `recv`, `close` |

### Quick Reference

```rust
// Dedicated thread
thread := Thread.spawn(() => { /* work */ });
thread.join();

// Thread pool task
Worker.spawn(() => { /* work */ });

// Communication (future)
(tx, rx) := Channel(i32).create();
tx.send(42);
value := rx.recv();
```

### Key Principles

1. **Separation of concerns** - Thread/Worker = execution, Channel = communication
2. **Send trait** - only Send types can cross thread boundaries
3. **Thread-local GC** - no cross-thread GC coordination
4. **Non-atomic RC** - no atomic overhead for thread-local objects
5. **Thread affinity** - Worker tasks stay on assigned OS thread
