# Parallelism - Multi-Threaded Execution for Yo

## Philosophy

Yo provides two mechanisms for parallel execution:

1. **Thread** - A dedicated OS thread (wrapper around pthread)
2. **ThreadPool** - A pool of worker threads that tasks are handed to, with thread affinity

Communication between threads is done via **Channel** (`std/sync/channel.yo`) — a bounded, multi-producer multi-consumer queue with blocking send/recv.

This is similar to:

- **Go**: goroutines (ThreadPool) + channels
- **Rust**: std::thread (Thread) + mpsc channels
- **Java**: Thread + ExecutorService (ThreadPool) + BlockingQueue

**Key Insight**: By separating execution (Thread/ThreadPool) from communication (Channel), we get a simpler and more flexible design.

## Concurrency vs Parallelism

| Concept         | Mechanism         | Description                                |
| --------------- | ----------------- | ------------------------------------------ |
| **Concurrency** | `async/await`     | Multiple tasks interleaved on ONE thread   |
| **Parallelism** | `Thread`/`ThreadPool` | Multiple tasks running on SEPARATE threads |

See `ASYNC_AWAIT.md` for single-threaded concurrency.

## Per-Thread Event Loop

Each OS thread (both Thread and ThreadPool workers) gets its own async event loop:

- **Linux**: per-thread `io_uring` instance
- **macOS**: per-thread `kqueue` descriptor
- **Windows**: per-thread IOCP handle
- **WASM**: not applicable — WASM is single-threaded; parallelism (`Thread.spawn`, workers) is not supported. Use `io.async`/`io.await` for cooperative concurrency instead.

This means spawned threads and worker tasks can perform async I/O via `io.async`/`io.await` without contention — each thread's event loop is fully independent.

The runtime automatically initializes the event loop when the thread starts (`__yo_async_scheduler_init()`) and drains pending tasks when the closure completes (`__yo_async_wait_all()`). I/O backend state is `_Thread_local`, so no synchronization is needed.

## Thread - Dedicated OS Thread

`Thread` is a simple wrapper around OS threads (pthread on Unix, Windows threads on Windows).

### API

```rust
Thread :: struct(
  handle : __yo_thread_t
);
impl(Thread,
  // Spawn a new OS thread running the given closure.
  // The closure receives its own per-thread Io event loop.
  spawn : (fn(cb : Impl(Fn(io : Io) -> unit, Send)) -> Self),

  // Wait for the thread to complete (blocking)
  join : (fn(inout(self) : Self) -> unit)
);
```

### Usage

```rust
{ Thread } :: import "std/thread";
{ yield } :: import "std/async";

// Spawn a dedicated thread (no async)
thread := Thread.spawn((io) => {
  printf("Hello from thread\n");
});
thread.join();

// Spawn a thread with async I/O
thread := Thread.spawn((io : Io) => {
  task := io.async((io : Io) => {
    io.await(yield());
    return i32(42);
  });
  result := io.await(task);
  assert(result == i32(42), "async result");
});
thread.join();
```

### When to Use Thread

- Long-running background tasks
- Tasks that need a dedicated OS thread (e.g., blocking I/O)
- UI applications (main thread + worker threads)
- When you need explicit control over thread lifecycle

## ThreadPool - Thread Pool Tasks

`ThreadPool` hands tasks to a **pool of worker threads** with **thread affinity**. Each task stays on its assigned OS thread (no work stealing).

The OS worker threads are a single process-global pool owned by the runtime; a
`ThreadPool` value is the explicit handle on it. It decides the thread count,
submits tasks and drains them. Two consequences: the `num_threads` passed to
`new` only takes effect while the runtime pool has not started yet, and
`join_all`/`shutdown` drain the runtime pool, so two `ThreadPool` values in one
program drain each other's work as well.

### API

```rust
{ ThreadPool, spawn } :: import "std/thread";

// Create a pool that requests `num_threads` worker threads
ThreadPool.new : (fn(num_threads : usize) -> ThreadPool);

// Create a pool sized to the number of hardware threads
ThreadPool.with_hardware_threads : (fn() -> ThreadPool);

// Number of worker threads in use (or about to be)
ThreadPool.num_threads : (fn(self : ThreadPool) -> usize);

// Hand a task to the pool — a module-level function, not a method
spawn : (fn(pool : ThreadPool, cb : Impl(Fn(io : Io) -> unit, Send)) -> unit);

// Block until every task submitted so far has finished; the pool stays open
ThreadPool.join_all : (fn(self : ThreadPool) -> unit);

// Refuse new work, then drain. Idempotent.
ThreadPool.shutdown : (fn(self : ThreadPool) -> unit);
ThreadPool.is_shutdown : (fn(self : ThreadPool) -> bool);
```

### Usage

```rust
{ ThreadPool, spawn } :: import "std/thread";
{ yield } :: import "std/async";

pool := ThreadPool.new(usize(4));

// Simple tasks on the pool
spawn(pool, (io : Io) => {
  do_work();
});

// Async tasks on the pool — each worker thread has its own event loop
spawn(pool, (io : Io) => {
  task := io.async((io : Io) => {
    io.await(yield(io), io);
  });
  io.await(task, io);
});

// Wait for everything submitted so far
pool.join_all();

// Refuse new work and drain
pool.shutdown();
```

`join_all` is a **barrier**, not a counter: it submits one sentinel task per
worker thread and waits for all of them. Because the runtime hands consecutive
submissions to consecutive worker threads and each worker runs its queue in
FIFO order, once every sentinel has run, every task queued before it has run
too. Do not call `join_all` from inside a pool task — the caller's worker
thread would be busy waiting for its own sentinel.

### Thread Pool Design

```
┌────────────────────────────────────────────────────────────────┐
│                         Thread Pool                            │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ OS Thread 0  │  │ OS Thread 1  │  │ OS Thread 2  │  ...     │
│  │ (CPU 0)      │  │ (CPU 1)      │  │ (CPU 2)      │          │
│  ├──────────────┤  ├──────────────┤  ├──────────────┤          │
│  │ Event Loop   │  │ Event Loop   │  │ Event Loop   │          │
│  │ Task Queue   │  │ Task Queue   │  │ Task Queue   │          │
│  │ [A, D, G]    │  │ [B, E, H]    │  │ [C, F, I]    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                │
│  - Thread-per-core: one OS thread per CPU core                 │
│  - Thread affinity: tasks stay on assigned thread              │
│  - Per-thread event loop: async I/O without contention         │
│  - No work stealing: predictable, cache-friendly               │
└────────────────────────────────────────────────────────────────┘
```

### When to Use ThreadPool

- Many short-lived tasks
- CPU-bound parallel work
- When you wait for a whole batch rather than for individual tasks
- Task parallelism (map-reduce style)

## Channel - Inter-Thread Communication

Channel (`std/sync/channel.yo`) provides bounded, multi-producer multi-consumer communication between threads.

```rust
{ Channel } :: import "std/sync/channel";

// Create a bounded channel (capacity 10)
ch := Channel(i32).new(usize(10));

// Producer thread
Thread.spawn((io) => {
  ch.send(i32(42));
});

// Consumer thread
Thread.spawn((io) => {
  val := ch.recv();
  cond(
    val.is_some() => printf("Got %d\n", val.unwrap()),
    true => ()
  );
});
```

`Channel` is implemented as an `atomic(ref(struct(...)))`, so it is directly shareable across
threads. No extra `arc()` wrapper is needed.

Channel uses a `Mutex` + `CondVar` internally for synchronization. Send blocks when the channel is full; recv blocks when the channel is empty.

## Sendable Types

Only types that implement `Send` can cross thread boundaries:

- **Sendable**: primitives (`i32`, `bool`, etc.), value structs composed of Send fields
- **Not Sendable**: `ref(struct(...))`, `Dyn`, closures capturing non-Send values

```rust
// ✅ Sendable
Point :: struct(x: i32, y: i32);
Thread.spawn((io) => {
  p := Point(1, 2);  // OK: created inside thread
});

// ❌ Not Sendable
Node :: ref(struct(value: i32));
node := Node(42);
Thread.spawn((io) => {
  // ERROR: Cannot capture `node` (reference-semantics type is not Send)
  // node.value;
});
```

## Memory Model

### Thread-Local GC

Each OS thread has:

- **Separate heap**: GC-managed allocations are thread-local
- **Non-atomic RC**: Reference counting uses non-atomic operations
- **Thread-local cycle collector**: GC runs independently per thread
- **Thread-local event loop**: I/O state is `_Thread_local`

This means:

- No data races on GC-managed values (they can't be shared)
- No atomic overhead for reference counting
- No stop-the-world GC pauses
- No contention on async I/O

## Comparison: Thread vs ThreadPool

| Aspect          | Thread                   | ThreadPool                 |
| --------------- | ------------------------ | -------------------------- |
| OS Thread       | Dedicated (1:1)          | Shared (thread pool)       |
| Lifecycle       | Explicit (`join`)        | Batch (`join_all`/`shutdown`) |
| Overhead        | Higher (thread creation) | Lower (reuses threads)     |
| Use Case        | Long-running tasks       | Short-lived tasks          |
| Thread Affinity | N/A                      | Yes (task stays on thread) |
| Async I/O       | Own event loop           | Shared per-thread loop     |

Neither `Thread.join` nor `ThreadPool.join_all` carries a value out of a
thread. To return a result, hand it back over a `Channel`.

## Summary

| Component   | Purpose                | API                   |
| ----------- | ---------------------- | --------------------- |
| **Thread**  | Dedicated OS thread    | `spawn`, `join`       |
| **ThreadPool** | Thread pool         | `new`, `spawn`, `join_all`, `shutdown` |
| **Channel** | Blocking communication | `new`, `send`, `recv` |

### Quick Reference

```rust
{ Thread, ThreadPool, spawn } :: import "std/thread";
{ Channel } :: import "std/sync/channel";

// Dedicated thread with async I/O
thread := Thread.spawn((io : Io) => {
  // This thread has its own event loop
  task := io.async((io : Io) => { io.await(yield()); });
  io.await(task);
});
thread.join();

// Thread pool task
pool := ThreadPool.new(usize(4));
spawn(pool, (io : Io) => { /* work */ });
pool.join_all();

// Communication
ch := Channel(i32).new(usize(10));
ch.send(i32(42));
val := ch.recv();
```

### Key Principles

1. **Separation of concerns** - Thread/ThreadPool = execution, Channel = communication
2. **Send trait** - only Send types can cross thread boundaries
3. **Thread-local GC** - no cross-thread GC coordination
4. **Non-atomic RC** - no atomic overhead for thread-local objects
5. **Thread affinity** - pool tasks stay on assigned OS thread
6. **Per-thread event loop** - each thread gets independent async I/O
