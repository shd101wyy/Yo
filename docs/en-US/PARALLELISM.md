# Parallelism - Multi-Threaded Execution for Yo

## Philosophy

Yo provides two mechanisms for parallel execution:

1. **Thread** - A dedicated OS thread (wrapper around pthread)
2. **ThreadPool** - A pool that owns its worker threads; tasks wait in one shared queue, and `spawn_on` pins a task to one worker

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
- **WASM**: not applicable — WASM is single-threaded; parallelism (`Thread(T).spawn`, workers) is not supported. Use `io.async`/`io.await` for cooperative concurrency instead.

This means spawned threads and worker tasks can perform async I/O via `io.async`/`io.await` without contention — each thread's event loop is fully independent.

The runtime automatically initializes the event loop when the thread starts (`__yo_async_scheduler_init()`) and drains pending tasks when the closure completes (`__yo_async_wait_all()`). I/O backend state is `_Thread_local`, so no synchronization is needed.

## Thread - Dedicated OS Thread

`Thread` is a simple wrapper around OS threads (pthread on Unix, Windows threads on Windows).

### API

```yo
// `T` is what the thread's body produces. `Thread(unit)` is the value-less
// thread; any `Send` type may be carried out.
Thread :: (
  fn(comptime(T) : Type, where(T <: Send)) -> comptime(Type)
)(struct(_cell : Box(_ThreadState(T))));
impl(
  generic(T : Type),
  Thread(T),
  where(T <: Send),
  // Spawn a new OS thread running the given closure.
  // The closure receives its own per-thread Io event loop.
  spawn : (fn(sink(cb) : Impl(FnOnce(io : Io) -> T, Send)) -> Self),
  // Wait for the thread to complete (blocking) and take its result.
  // Panics on a second call.
  join : (fn(self : &Self) -> T),
  is_joined : (fn(self : &Self) -> bool)
);
```

The body runs exactly once, so `spawn` takes it as `FnOnce` and owns it
(`sink(cb)`). A closure with a capture list (`{ t }(io : Io) => ...`) may
move a captured value out instead of cloning it, for example by handing it
to a `sink` parameter or sending it over a channel (the value must be
`Send`). Any capture it did not move is dropped when the body returns. An
ordinary closure is accepted too, because `Fn` implies `FnOnce`.

```yo
Job :: struct(id : i32);
run :: (fn(sink(j) : Job) -> i32)(j.id);
job := Job(id : i32(7));
t := Thread(i32).spawn({ job }(io : Io) => run(job)); // job moves into the thread, no clone
n := t.join(); // 7
```

A `Thread` is a move-only value: its OS handle, joined flag and result
channel live in a `Box`, so there is exactly one handle per thread and
dropping it unjoined detaches the thread once. `t2 := t` moves the handle,
and a copy that would leave two owners is E0901. Lend it with `&t`, or move
it to wherever it is joined. Because `join` marks the handle inside the box
through `&Self`, a `Thread` is `Send` but never `Sync`.

### Carrying a value out

`join()` returns what the body returned, over a capacity-1 `Channel(T)` the
handle owns:

```yo
{ Thread } :: import("std/thread");

t := Thread(i32).spawn((io : Io) => i32(42));
answer := t.join(); // 42
```

`Thread(unit)` is the value-less thread the examples below use, and its
`join()` returns `()`. `ThreadPool` tasks still carry nothing — hand a pool
task's value back over a `Channel`.

### Usage

```yo
{ Thread } :: import("std/thread");
{ yield } :: import("std/async");

// Spawn a dedicated thread (no async)
thread := Thread(unit).spawn(io => {
  printf("Hello from thread\n");
});
thread.join();

// Spawn a thread with async I/O
thread := Thread(unit).spawn((io : Io) => {
  task := io.async((io : Io) => {
    io.await(yield(io), io);
    return(i32(42));
  });
  result := io.await(task, io);
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

A `ThreadPool` owns `n` worker threads, created by `new(n)` and joined when the
pool is dropped or `shutdown`.

Every worker has its own async event loop, so a task may use
`io.async`/`io.await` on the `io` it is handed. A started task never moves to
another thread: `Io` and `JoinHandle` are `!Send`, and reference counts are
per-thread and non-atomic.

Unstarted tasks wait in one queue shared by the workers. `spawn(&pool, cb)` is
taken by the first idle worker, so a slow task delays nothing queued behind
it, and CPU-bound work balances itself.

A task that must run on a particular worker, because of shard-local state or a
per-worker cache, is placed explicitly with `spawn_on(&pool, i, cb)`. Only that
worker takes it (`pool.worker_count()`, `worker_id()`).

Each worker runs one task at a time to completion, including the async work
that task spawned. `join_all` is a completion counter over the tasks this pool
submitted.

There is no work stealing and no CPU affinity: the runtime never pins a thread
to a core, and a started task never migrates.

### API

```yo
{ ThreadPool, spawn, spawn_on, worker_id } :: import("std/thread");

// Create a pool that owns exactly `num_threads` worker threads
ThreadPool.new : (fn(num_threads : usize) -> ThreadPool);

// Create a pool with one worker per hardware thread
ThreadPool.with_hardware_threads : (fn() -> ThreadPool);

// The number of workers the pool owns
ThreadPool.worker_count : (fn(self : &ThreadPool) -> usize);

// Hand a task to the pool's shared queue: the first idle worker takes it.
// A module-level function, not a method.
spawn : (fn(pool : &ThreadPool, sink(cb) : Impl(FnOnce(io : Io) -> unit, Send)) -> unit);

// Hand a task to worker `worker` only (0 <= worker < pool.worker_count())
spawn_on : (fn(pool : &ThreadPool, worker : usize, sink(cb) : Impl(FnOnce(io : Io) -> unit, Send)) -> unit);

// The running pool task's worker; .None on any other thread
worker_id : (fn() -> Option(usize));

// Block until every task submitted so far has finished; the pool stays open
ThreadPool.join_all : (fn(self : &ThreadPool) -> unit);

// Refuse new work, run what was submitted, join the workers. Idempotent.
ThreadPool.shutdown : (fn(self : &ThreadPool) -> unit);
ThreadPool.is_shutdown : (fn(self : &ThreadPool) -> bool);

// impl(ThreadPool, Drop(...)): dropping the pool is `shutdown`
```

### Usage

```yo
{ ThreadPool, spawn, spawn_on, worker_id } :: import("std/thread");
{ yield } :: import("std/async");

pool := ThreadPool.new(usize(4));

// Simple tasks on the pool
spawn(&pool, (io : Io) => {
  do_work();
});

// Async tasks on the pool — each worker thread has its own event loop
spawn(&pool, (io : Io) => {
  task := io.async((io : Io) => {
    io.await(yield(io), io);
  });
  io.await(task, io);
});

// One task per worker, each on its own shard
(mut(i) : usize) = usize(0);
while(i < pool.worker_count(), {
  spawn_on(&pool, i, (io : Io) => {
    shard := worker_id().unwrap();
    work_on_shard(shard);
  });
  i = (i + usize(1));
});

// Wait for everything submitted so far
pool.join_all();

// Dropping `pool` at the end of its scope refuses new work, runs what was
// submitted and joins the workers.
```

`join_all` is a **completion counter**: `spawn` counts a task in, and the
task's wrapper counts it out after it returns, so `join_all` returns once every
task submitted through this pool so far (and every task those tasks submitted
into it) has finished. Do not call `join_all` from inside a task of the same
pool — the task would be waiting for itself.

### Sharing a pool

A `ThreadPool` is a move-only value. Lend it as `&pool`, or share it between
threads and tasks as `Arc(ThreadPool)`:

```yo
pool := Arc.new(ThreadPool.new(usize(4)));
spawn(&pool.*, { pool : Arc.clone(pool) }(io : Io) => {
  // a task that submits more work into its own pool
  spawn(&pool.*, (io : Io) => { do_work(); });
});
```

The pool is shut down when the last owner drops it. When that owner is one of
the pool's own tasks, the drop cannot wait for the task it runs in: it closes
the pool and returns, and the workers run what was submitted, then exit.

A pool held in a module global is never dropped: its workers live until the
process exits, and exit does not wait for them, as for a detached `Thread`.

### Thread Pool Design

```
┌───────────────────────────────────────────────────────────────────┐
│                           ThreadPool                              │
│                                                                   │
│  Shared queue: [D, E, F, ...]   (taken by the first idle worker)  │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │ Worker 0     │  │ Worker 1     │  │ Worker 2     │  ...        │
│  ├──────────────┤  ├──────────────┤  ├──────────────┤             │
│  │ Event Loop   │  │ Event Loop   │  │ Event Loop   │             │
│  │ Pinned queue │  │ Pinned queue │  │ Pinned queue │             │
│  │ (spawn_on)   │  │ (spawn_on)   │  │ (spawn_on)   │             │
│  └──────────────┘  └──────────────┘  └──────────────┘             │
│                                                                   │
│  - Exactly n workers, owned by the pool, joined when it drops     │
│  - A worker takes its pinned queue first, then the shared queue   │
│  - One task at a time per worker, run to completion               │
│  - No work stealing, no CPU affinity; a started task never moves  │
└───────────────────────────────────────────────────────────────────┘
```

### When to Use ThreadPool

- Many short-lived tasks
- CPU-bound parallel work
- When you wait for a whole batch rather than for individual tasks
- Task parallelism (map-reduce style)

## Channel - Inter-Thread Communication

Channel (`std/sync/channel.yo`) provides bounded, multi-producer multi-consumer communication between threads.

```yo
{ Channel } :: import("std/sync/channel");

// Create a bounded channel (capacity 10)
ch := Channel(i32).new(usize(10));

// Producer thread: its own handle on the queue
tx := ch.clone();
producer := Thread(unit).spawn({ tx }(io : Io) => {
  _ := tx.send(i32(42));
});

// Consumer thread
rx := ch.clone();
consumer := Thread(unit).spawn({ rx }(io : Io) => {
  val := rx.recv();
  cond(
    val.is_some() => printf("Got %d\n", val.unwrap()),
    true => ()
  );
});
producer.join();
consumer.join();
```

A `Channel(T)` is a value holding an `Arc` of its queue, and it is `Send` and `Sync` when `T`
is `Send`. `ch.clone()` is another handle on the same queue (no `Arc.new()` wrapper is needed),
and the queue is freed with the last handle. An implicit copy (`ch2 := ch` with `ch` used
again) is E0901: clone it once per thread that needs it and capture the clone by value.

Channel uses a `Mutex` + `CondVar` internally for synchronization. Send blocks when the channel is full; recv blocks when the channel is empty.

### Sender / Receiver - end of stream without a manual `close()`

A `Channel` is one fused handle that both ends share, and it stays open until somebody
calls `close()`. When a consumer needs to know that the producers are *finished*, use the
`Sender`/`Receiver` split instead: the queue counts its live senders, and dropping the last
one closes the channel by itself.

```yo
{ Channel } :: import("std/sync/channel");

rx := Channel(i32).receiver(usize(4)); // the queue and its one consumer
{
  tx := rx.sender(); // a counted producer
  tx.send(i32(1));
  tx.send(i32(2));
}; // last sender dropped -> channel closed
rx.recv().unwrap(); // 1  - buffered values come out first
rx.recv().unwrap(); // 2
rx.recv(); // .Err(TryRecvError.Disconnected)
```

- `Sender` is cloneable (`tx.clone()`); every clone is another counted producer, and only
  the LAST one to be dropped closes the queue.
- Dropping the `Receiver` makes every further `send` fail with the unsent value, instead of
  blocking on a queue nobody will drain.
- `Receiver.recv()` returns `Result(T, TryRecvError)`; the error is always `Disconnected`,
  and it is reported only once the buffer is drained, so no accepted value is lost.
- `Channel(T).pair(capacity)` returns both halves as a tuple for a Rust-like one-liner, but
  the tuple keeps both handles alive for its whole scope - so dropping the sender early does
  *not* close the channel. Prefer `receiver()` + `sender()` whenever the end of the stream
  matters.

A `Sender` is a value holding its own `Channel` handle: `tx.clone()` attaches a counted
producer, dropping one detaches it, and an implicit copy is E0901 (it would bypass the count).
The `Receiver` has no `Clone`, and copying it is E0901, so the one consumer stays one. For
producers on other threads, move a `Sender` of its own into each thread's closure:

```yo
rx := Channel(i32).receiver(usize(16));
{
  tx := rx.sender();
  tx2 := tx.clone(); // a second counted producer
  w1 := Thread(unit).spawn({ tx }(io : Io) => {
    _ := tx.send(i32(7));
  });
  w2 := Thread(unit).spawn({ tx2 }(io : Io) => {
    _ := tx2.send(i32(8));
  });
  w1.join();
  w2.join();
}; // both senders dropped with their threads -> channel closed
```

A `Sender` *moved into* a `Thread(T).spawn` closure closes the channel when it is the last one:
the spawn wrapper releases the thread's capture struct when the body returns, so that sender's
drop runs
(issues/fixed/spawn-closure-captures-never-dropped-leak.md, and
issues/fixed/a-closure-typed-slot-never-releases-its-captures.md for a capture that is itself
a closure). Async tasks (`std/async/channel`, which has the same
`receiver()`/`sender()`/`pair()` API for one event loop) release their captures the same way.

## Sendable Types

Only types that implement `Send` can be moved across thread boundaries, and only types that
implement `Sync` can be shared between threads (an `Arc` payload, a module-level global); see
"The Send and Sync Traits" in `THREAD_SAFETY.md`:

- **Sendable**: primitives (`i32`, `bool`, etc.), value structs/enums/tuples composed of Send
  fields, `String`, `ArrayList(T)` and `HashSet(T)` when `T` is Send, `HashMap(K, V)` when `K` and `V` are (each owns its buffers uniquely), `Arc(T)` (its payload is `Send` and `Sync`), the `std/sync` types
  (`Mutex(T)` and `Channel(T)` when `T` is Send, the `Atomic*` wrappers and the other locks), `Box(Dyn(Trait, Send))` (the concrete type is checked at `dyn(...)`; in v0.2.77 the
  owned payload is still atomically counted), and function values (a named function or a closure) whose captures are
  all Send and whose code reaches no non-Send module global — judged from the value where the
  compiler can see it: a spawn body, an `Impl(Fn(...), Send)` or `Impl(FnOnce(...), Send)` argument, a generic
  `where(T <: Send)` argument, a captured variable
- **Not Sendable**: `Rc(T)` (non-atomic RC) and values holding one, raw pointers and types holding one
  unless they opt in, `Box(Dyn(Trait))` without `Send` in its bound, `Io`, `JoinHandle`, closures
  that borrow their captures,
  function values capturing any of those or reaching a non-Send global, and a bare
  `fn(...)` type whose value is not known there (a struct field, a `Channel(fn() -> unit)`
  payload) — see "Functions and Closures Across Threads" in `THREAD_SAFETY.md`

An `Rc` graph stays on its thread (Rust's rule). A `String` or a collection of `Send`
elements is `Send`: it moves to another thread by value, and data that several threads
read goes through an `Arc`.

```yo
// ✅ Sendable
Point :: struct(x : i32, y : i32);
Thread(unit).spawn(io => {
  p := Point(1, 2); // OK: created inside thread
});

// ❌ Not Sendable
node := Rc.new(i32(42));
Thread(unit).spawn(io => {
  // ERROR: Cannot capture `node` (an `Rc` is not Send)
  // node.*;
});
```

## Memory Model

### Thread-Local Reference Counting

Each OS thread has:

- **Thread-local values**: a non-atomic reference cell (`ref`, `Rc`) never leaves its thread
- **Non-atomic RC**: Reference counting uses non-atomic operations
- **Thread-local event loop**: I/O state is `_Thread_local`

This means:

- No data races on reference-counted values (they can't be shared)
- No atomic overhead for reference counting
- No garbage-collection pauses: there is no collector
- No contention on async I/O

## Comparison: Thread vs ThreadPool

| Aspect          | Thread                   | ThreadPool                 |
| --------------- | ------------------------ | -------------------------- |
| OS Thread       | Dedicated (1:1)          | The pool's own `n` workers |
| Lifecycle       | Explicit (`join`)        | Batch (`join_all`); drop = `shutdown` |
| Overhead        | Higher (thread creation) | Lower (reuses threads)     |
| Use Case        | Long-running tasks       | Short-lived tasks          |
| Pinning         | N/A                      | Explicit (`spawn_on`)      |
| Async I/O       | Own event loop           | Each worker's own loop     |

`Thread(T).join()` returns the thread's `T`. `ThreadPool.join_all` carries
no value: to return a result from a pool task, hand it back over a
`Channel`.

## Summary

| Component   | Purpose                | API                   |
| ----------- | ---------------------- | --------------------- |
| **Thread**  | Dedicated OS thread    | `spawn`, `join`       |
| **ThreadPool** | Thread pool         | `new`, `spawn`, `spawn_on`, `join_all`, `shutdown` |
| **Channel** | Blocking communication | `new`, `send`, `recv` |

### Quick Reference

```yo
{ Thread, ThreadPool, spawn } :: import("std/thread");
{ Channel } :: import("std/sync/channel");

// Dedicated thread with async I/O
thread := Thread(unit).spawn((io : Io) => {
  // This thread has its own event loop
  task := io.async((io : Io) => {
    io.await(yield(io), io);
  });
  io.await(task, io);
});
thread.join();

// Thread pool task
pool := ThreadPool.new(usize(4));
spawn(&pool, (io : Io) => { /* work */ });
pool.join_all();

// Communication
ch := Channel(i32).new(usize(10));
ch.send(i32(42));
val := ch.recv();
```

### Key Principles

1. **Separation of concerns** - Thread/ThreadPool = execution, Channel = communication
2. **Send trait** - only Send types can cross thread boundaries
3. **Thread-local RC** - no cross-thread coordination of non-atomic counts
4. **Non-atomic RC** - no atomic overhead for thread-local objects
5. **Shared queue, explicit pinning** - an idle pool worker takes the next task; `spawn_on` pins one; a started task never moves
6. **Per-thread event loop** - each thread gets independent async I/O
