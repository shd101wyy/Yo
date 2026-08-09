# Async/Await - Single-Threaded Concurrency for Yo

## Philosophy

Yo uses **async/await with state machine transformation** via **algebraic effects** for efficient **single-threaded concurrency**. This is a stackless coroutine model similar to JavaScript's event loop - all async code runs on the **same thread** as the caller.

**Key Insight**: `io.async`/`io.await` provides **concurrency** (interleaved execution), not **parallelism** (simultaneous execution). For parallelism, see `PARALLELISM.md` which describes the `Task.spawn` API for isolated multi-threaded execution.

```rust
{ yield } :: import "std/async";

// All async code runs on the SAME thread
main :: (fn(io : Io) -> unit)({
  task1 := io.async((io : Io)=> {
    io.await(yield());
    return i32(1);
  });
  task2 := io.async((io : Io)=> {
    io.await(yield());
    return i32(2);
  });
  // spawn starts both without waiting, returning JoinHandles
  handle1 := io.spawn(task1);
  handle2 := io.spawn(task2);
  // await on handles and extract results (Option(T))
  result1 := handle1.await(io);
  result2 := handle2.await(io);
});
export main;
```

## Concurrency vs Parallelism

| Concept         | Mechanism             | Description                                |
| --------------- | --------------------- | ------------------------------------------ |
| **Concurrency** | `io.async`/`io.await` | Multiple tasks interleaved on ONE thread   |
| **Parallelism** | `Task.spawn`          | Multiple tasks running on SEPARATE threads |

```rust
// Concurrency: Same thread, interleaved execution
main :: (fn(io : Io) -> unit)({
  a := io.async((io : Io)=> { /* ... */ });
  b := io.async((io : Io)=> { /* ... */ });
  io.spawn(a);  // Start a without waiting (returns JoinHandle)
  io.spawn(b);  // Start b without waiting (returns JoinHandle)
  io.await(a);
  io.await(b);
});

// Parallelism: Different threads, true simultaneous execution
task := Task(i32, bool).spawn((parent) -> {
  // Runs on a DIFFERENT thread!
  // Completely isolated - no shared memory
});
```

## Execution Model: Lazy Start via Algebraic Effects

Yo's async uses **algebraic effects** with the `Io` effect type. Async tasks are **lazy** — they don't start until explicitly awaited or spawned:

- `io.async(fn)` creates a **cold Future** — the function body is NOT executed yet
- `io.await(task)` starts a cold task and runs it to completion (sequential)
- `io.spawn(task)` starts a cold task **without waiting** for it to complete, returns `JoinHandle(T)`

```rust
{ yield } :: import "std/async";

main :: (fn(io : Io) -> unit)({
  counter := Box(i32)(0);

  // Lazy creation — neither task starts yet
  task1 := io.async((io : Io)=> {
    counter.* = (counter.* + 1);   // Runs when started
    io.await(yield());              // Yields to event loop
    counter.* = (counter.* + 1);   // Resumes after other tasks yield
  });

  task2 := io.async((io : Io)=> {
    counter.* = (counter.* + 10);
    io.await(yield());
    counter.* = (counter.* + 10);
  });

  // counter is still 0 here — tasks haven't started
  assert((counter.* == i32(0)), "tasks are lazy");

  // spawn starts both without waiting:
  // 1. task1 runs: counter=0→1, yields
  // 2. task2 runs: counter=1→11, yields
  handle1 := io.spawn(task1);
  handle2 := io.spawn(task2);

  // handle.await waits for completion and returns Option(T):
  // 3. task1 resumes: counter=11→12
  // 4. task2 resumes: counter=12→22
  handle1.await(io);
  handle2.await(io);

  assert((counter.* == i32(22)), "both tasks interleaved and completed");
});
export main;
```

**Key Difference from Eager Models (old Yo, C#, C++):**

- Eager: `let f = async_fn()` runs immediately until first `await`
- Lazy (current): `task := io.async(fn)` does nothing until `io.await(task)` or `io.spawn(task)`

## Motivation

### Why Single-Threaded Async?

1. **Simplicity**: No thread safety concerns, no Send trait needed for async
2. **No data races**: All async code runs on one thread
3. **Memory Efficiency**: State machines only need ~100-500 bytes per task
4. **Massive Concurrency**: Can handle millions of concurrent tasks
5. **Zero-Cost Abstraction**: State machine transformation at compile time
6. **Familiar Model**: Similar to JavaScript's event loop - proven and intuitive
7. **No Atomics Needed**: Reference counting doesn't need atomic operations
8. **Algebraic Effects**: Io capabilities are explicit via `io : Io`

### Why Not Multi-Threaded Async?

Multi-threaded async (like Rust's tokio) adds complexity:

- Need `Send` trait to verify thread safety
- Need atomic reference counting
- Need cross-thread synchronization
- Work-stealing adds overhead

Yo's approach: Keep async simple (single-threaded), use `Task.spawn` for parallelism (isolated threads).

## Language Syntax

```rust
{ yield } :: import "std/async";

// Async task creation (lazy — doesn't run until awaited/spawned)
task := io.async((io : Io)=> {
  io.await(yield());  // Yield to event loop
  return i32(42);
});

// Sequential await: starts the task, runs to completion
result := io.await(task);

// Concurrent: spawn starts tasks without waiting, returns JoinHandle(T)
handle1 := io.spawn(task1);
handle2 := io.spawn(task2);
handle3 := io.spawn(task3);

// Then handle.await extracts results as Option(T)
r1 := handle1.await(io);
r2 := handle2.await(io);
r3 := handle3.await(io);
```

### Io Effect and Using

Async operations require the `Io` effect, passed via `io : Io`:

```rust
// Main function receives Io effect
main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io)=> {
    // Can use io.await, io.async, io.spawn here
    io.await(yield());
  });
  io.await(task);
});
export main;

// Test blocks automatically have `io : Io` available
test "my test", {
  task := io.async((io : Io)=> { /* ... */ });
  io.await(task);
};
```

### API

```rust
io.async(fn)                  // Create a cold Future (lazy, doesn't start)
io.await(future)              // Start if cold, wait for completion, return result
io.state(future)              // Query the current state of a Future (returns FutureState)
io.spawn(future)              // Start a cold Future without waiting, returns JoinHandle(T)
handle.await(io)       // Wait for spawned task, returns Option(T) (.None on unwind)
yield()                       // Create a pre-completed Future (yields control to event loop)
```

**Important Rules**:

1. `io.async(fn)` creates a **lazy** Future — the function body does NOT execute until awaited or spawned
2. `io.await(future)` starts a cold future and runs it sequentially to completion
3. `io.state(future)` returns the current `FutureState` without blocking or starting the Future
4. `io.spawn(future)` starts a cold future without waiting — returns `JoinHandle(T)` for later awaiting
5. `handle.await(io)` waits for a spawned task and returns `Option(T)` — `.Some(result)` on completion, `.None` on unwind (abort)
6. Spawning an already **aborted** Future causes a **panic**
7. All async code runs on the **same thread** — no thread spawning
8. `yield()` suspends the current task and yields to other ready tasks in the event loop
9. `io.await(future)` can be called **multiple times** on the same Future — each call returns the same result
10. Awaiting a Future that was **aborted** by an algebraic effect handler causes a **panic**

### Execution Model

```rust
// All three tasks run on the SAME thread
main :: (fn(io : Io) -> unit)({
  // LAZY — tasks are cold, nothing runs yet
  t1 := io.async((io : Io)=> { /* task1 body */ });
  t2 := io.async((io : Io)=> { /* task2 body */ });
  t3 := io.async((io : Io)=> { /* task3 body */ });

  // spawn starts each task without waiting:
  // - t1 runs until first yield, suspends
  // - t2 runs until first yield, suspends
  // - t3 runs until first yield, suspends
  h1 := io.spawn(t1);
  h2 := io.spawn(t2);
  h3 := io.spawn(t3);

  // handle.await waits for completion and returns Option(T):
  // - event loop resumes t1, t2, t3 in round-robin
  r1 := h1.await(io);
  r2 := h2.await(io);
  r3 := h3.await(io);
});
```

### Future Type

```rust
// `io.async(fn)` returns `Impl(Future(T))` — a pointer to a heap-allocated state machine.
// The state machine stores:
//   - state: int (0 = cold, 1..N = intermediate, -1 = completed, -2 = aborted)
//   - continuation_fn / continuation_sm (who to resume on completion)
//   - result: T (when completed; omitted for unit)
//   - captured vars + locals that cross await
// Dropping/disposing the Future frees the state machine.
```

#### Future with Effects

`Future(T)` can carry algebraic-effect information. The shape is:

```rust
Future(T)        // No effects
Future(T, E)     // Future yielding T with effect bundle E
```

`E` is a single type — typically a struct that bundles every effect the async body
needs (handler fields plus any `Io`-like records). The author packs the bundle
themselves; the language does not concatenate effects from multiple type arguments.

```rust
// A bundle struct carries every effect the task needs.
TaskCtx :: struct(io : Io, raise : Raise, log : Log);
```

**Matching rules**

1. **Type equality on the bundle.** `Future(T, E1)` matches `Future(T, E2)` when
   `E1` and `E2` are compatible types. There is no order-independent set matching
   anymore — there is no set, just one bundle.
2. **Unannotated and annotated mix freely.** `Future(T)` (no bundle) is
   compatible with `Future(T, E)` (any bundle). Use the unannotated form when
   the caller doesn't need to refer to the effect type.
3. **Io when the body awaits.** Any async body that calls `io.await` / `yield`
   needs an `Io` in its bundle, so the bundle struct typically has an `io : Io`
   field.

**Example: bundled effects through async**

```rust
{ yield } :: import "std/async";
Raise :: (fn(generic(T : Type), msg : String) -> T);
Log :: (fn(msg : String) -> unit);
TaskCtx :: struct(io : Io, raise : Raise, log : Log);

main :: (fn(io : Io) -> unit)({
  (raise : Raise) = ((msg) -> { return(i32(0)); });
  (log : Log) = ((msg) -> { println(msg); });
  ctx := TaskCtx(io: io, raise: raise, log: log);

  (task : Impl(Future(i32, TaskCtx))) = io.async((ctx : TaskCtx) => {
    ctx.log(`doing work`);
    ctx.io.await(yield(), ctx.io);
    i32(42)
  });

  result := io.await(task, ctx);
});
export main;
```

The `Io` effect record is itself a bundle-shaped struct that the async runtime
provides:

```rust
Io :: struct(
  async : (fn(generic(T : Type, E : Type.Struct), action : Impl(Fn(e : E) -> T)) -> Impl(Future(T, E))),
  await : (fn(generic(T : Type, E : Type.Struct), fut : Impl(Future(T, E)), e : E) -> T),
  state : (fn(generic(T : Type, E : Type.Struct), fut : Impl(Future(T, E))) -> FutureState),
  spawn : (fn(generic(T : Type, E : Type.Struct), fut : Impl(Future(T, E)), e : E) -> JoinHandle(T))
);
```

Why heap allocation?

- A Future can suspend at an `await` and resume later; the state machine must have a stable address after the current C stack frame returns.
- The runtime queues continuations as `(resume_fn, state_machine_ptr)`, so the state machine must outlive the scheduling point.

This is an implementation choice, not a semantic requirement.

### Multi-Await

A Future can be awaited **multiple times**. Each `io.await` call on the same Future returns the same result:

```rust
main :: (fn(io : Io) -> unit) {
  task := io.async(() => {
    return 42;
  });
  result1 := io.await(task);
  result2 := io.await(task);
  result3 := io.await(task);
  assert((result1 == 42), "first await returns 42");
  assert((result2 == 42), "second await returns 42");
  assert((result3 == 42), "third await returns 42");
};
export main;
```

The Future retains its result after completion. For reference-counted result types, each `io.await` call dups the result so the caller gets its own reference. The Future's dispose function drops the original when the state machine is freed.

### Aborted Futures

When an algebraic effect handler calls `unwind` inside an async task, the Future is marked as **aborted** (internal state = -2). The task's continuation is discarded and no result is stored.

**With `io.await`**: Attempting to `io.await` on an aborted Future causes a **panic**.

**With `handle.await`**: `JoinHandle.await` returns `Option(T)` — `.None` on abort, safely catching the unwind:

```rust
main :: (fn(io : Io) -> unit) {
  Raise :: (fn(generic(T : Type), msg : String) -> T);
  task := io.async((io : Io, raise : Raise) => {
    raise(`something went wrong`);
    return i32(42);
  });

  (raise : Raise) = (msg) -> { unwind (); };
  handle := io.spawn(task, io, raise);
  result := handle.await(io);
  // result is Option(i32).None — the task was aborted
  assert(result.is_none(), "aborted task returns None");
};
export main;
```

**Future State Machine States:**

| State | Meaning                                                | `FutureState` enum      |
| ----- | ------------------------------------------------------ | ----------------------- |
| 0     | Cold — not started yet                                 | `FutureState.Pending`   |
| 1..N  | Intermediate — suspended at an await/yield point       | `FutureState.Running`   |
| -1    | Completed — result is available                        | `FutureState.Completed` |
| -2    | Aborted — an effect handler called `unwind`, no result | `FutureState.Aborted`   |

### Querying Future State

`io.state(future)` returns the current `FutureState` without blocking or starting the Future. This is useful for polling or diagnostics:

```rust
FutureState :: enum(
  Pending = 0,     // Cold — not started yet
  Running = 1,     // In progress — suspended at an await/yield point
  Completed = -(1), // Completed — result is available
  Aborted = -(2)   // Aborted — an effect handler called unwind
);
```

```rust
main :: (fn(io : Io) -> unit) {
  task := io.async((io : Io)=> {
    io.await(yield());
    return i32(42);
  });

  // Before starting: Pending
  assert((io.state(task) == FutureState.Pending), "cold future is Pending");

  io.await(task);

  // After completion: Completed
  assert((io.state(task) == FutureState.Completed), "done future is Completed");
};
export main;
```

**Key points:**

- `io.state` is a **non-blocking**, **synchronous** read of the Future's internal state field
- Raw state machine values 1..N (intermediate suspend states) are all mapped to `FutureState.Running`
- `io.state` does **not** start a cold Future — it only observes
- Multiple `io.state` calls on the same Future are consistent

## State Machine Transformation

The compiler transforms async functions into state machines at each `await` point.

### Example Transformation

**Input Yo code:**

```rust
task := io.async((io : Io)=> {
  response := io.await(http_get(url));
  data := io.await(response.read());
  return data;
});
```

**Conceptual transformation:**

1. **State Machine Struct**:

   - Tracks current state (0, 1, 2...)
   - Captures function parameters (url)
   - Stores local variables used across await points (response, data)
   - Holds pending futures

2. **Poll Function**:

   - Switch statement with one case per state
   - State 0: Call http_get, check if ready
   - State 1: Extract response result, call read, check if ready
   - State 2: Extract data result, return Ready(data)

3. **Resume Function (Lazy Start)**:
   - State 0 (cold): Future is created but NOT started
   - When `io.await` or `io.spawn` triggers the first resume:
     - State 0: Call http_get, check if ready
     - State 1: Extract response result, call read, check if ready
     - State 2: Extract data result, return Ready(data)
   - At each yield/await point, the task yields for fairness

### Key Points

- Each `await` becomes a state transition
- Local variables used across `await` are captured in state struct
- Poll function is a switch statement advancing through states
- No threads involved - all polling happens on same thread

### Where `await` may appear inside `io.async`

Each `await` is a state transition, so it has to sit somewhere the body can be
_split_. Branch bodies split naturally. Conditions and `match` scrutinees are
evaluated before any branch is chosen, so they are **hoisted** across the state
boundary instead; a `while` condition, which re-runs every iteration, makes the
whole loop cycle through one state.

```rust
// ✓ supported
cond(needs_write => { io.await(write_file(p, data, io), io); }, true => ());
if(io.await(exists(p, io), io), { ... });
cond(io.await(ready(io), io) => ..., true => ...);
match(io.await(num(io), io), 42 => ..., _ => ...);
while(io.await(more(io), io), { ... });
while(c, { ... io.await(f, io) ... }, { ... });   // step, arg 2 of the 3-arg form

// ✗ rejected: the await is NESTED inside a larger condition
if(!(io.await(exists(p, io), io)), { ... });
// ✓ bind it first
found := io.await(exists(p, io), io);
if(!(found), { ... });

// ✗ rejected: a LATER cond branch. `cond` is lazy, so hoisting it would await
//   even when an earlier branch matches — a change of meaning, not of timing.
cond(c1 => ..., io.await(f, io) => ..., true => ...);
```

These are real suspensions: a task spawned before an awaited condition runs
while the awaiting task is suspended.

The restriction applies **only inside `io.async`**. In a plain `fn` body,
`io.await` drives the event loop synchronously and may appear anywhere an
expression may.

## Event Loop

The async runtime uses a simple **single-threaded event loop**:

```
┌─────────────────────────────────────────────┐
│              Event Loop (Main Thread)       │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │           Ready Queue               │    │
│  │  ┌─────┐ ┌─────┐ ┌─────┐           │    │
│  │  │Task1│ │Task2│ │Task3│  ...      │    │
│  │  └─────┘ └─────┘ └─────┘           │    │
│  └─────────────────────────────────────┘    │
│                    │                        │
│                    ▼                        │
│  ┌─────────────────────────────────────┐    │
│  │         Poll next ready task        │    │
│  │   - Run until await                 │    │
│  │   - If Io pending, register waker   │    │
│  │   - If ready, continue              │    │
│  └─────────────────────────────────────┘    │
│                    │                        │
│                    ▼                        │
│  ┌─────────────────────────────────────┐    │
│  │         Io Completion Check         │    │
│  │   - Check epoll/kqueue/IOCP         │    │
│  │   - Wake completed tasks            │    │
│  │   - Add to ready queue              │    │
│  └─────────────────────────────────────┘    │
│                                             │
└─────────────────────────────────────────────┘
```

### Event Loop Steps

1. **Dequeue** a ready task from the ready queue
2. **Poll** the task's state machine
3. **If await on pending Io**: Register waker, task sleeps
4. **If await on ready Future**: Continue to next state
5. **If complete**: Mark Future as ready, wake awaiters
6. **Check Io**: Poll OS for completed Io events
7. **Wake tasks**: Move woken tasks to ready queue
8. **Repeat** until all tasks complete

### Thread-Local Event Loop

Each OS thread has its own event loop. All async runtime state is thread-local (`_Thread_local` on POSIX, `__declspec(thread)` on Windows):

```c
// Per-thread task queue
static _Thread_local __yo_async_task_queue_t __yo_thread_async_queue = {NULL, NULL, 0};

// Per-thread event loop state
static _Thread_local bool __yo_async_scheduler_initialized = false;
static _Thread_local bool __yo_io_initialized = false;
static _Thread_local size_t __yo_pending_io_count = 0;
static _Thread_local size_t __yo_active_watch_count = 0;

// Per-thread I/O backend (Linux example)
static _Thread_local struct io_uring __yo_io_ring;
```

This means:

- **Main thread**: Has its own event loop for `io.async`/`io.await` tasks
- **Worker threads** (from `Task.spawn`): Each gets an independent event loop
- **Multiple workers per thread**: Workers on the same OS thread cooperatively share that thread's event loop
- **No cross-thread task migration**: Tasks always run on the thread that created them
- **No locking needed**: Queue operations are single-threaded by design
- **Process-global state** (signal handlers, WSA init, TTY settings) stays `static` — shared across all threads

### Runtime Initialization

The async runtime is generated conditionally — **only when the program uses async/await**:

- The compiler scans for `io.async`, `io.await`, and `io.spawn` calls during code generation
- If no async code is present, the runtime (scheduler, I/O subsystem, continuation queue) is **not emitted** at all, and `main()` calls the user function directly
- If async code is present, `main()` initializes the scheduler and waits for all tasks:

```c
int main(int argc, char** argv) {
  __yo_async_scheduler_init();   // Lightweight: just sets a flag
  __yo_user_main();
  __yo_async_wait_all();         // Drains queue; returns immediately if empty
  return 0;
}
```

**I/O initialization is lazy**: `__yo_io_init()` is called on the first actual I/O operation (file open, socket connect, etc.), not at program start. This means programs using only `yield()` and pure computation pay zero I/O setup cost.

Similarly, the **parallelism runtime** (thread pool, worker spawn, hardware detection) is only emitted when the program uses `Thread.spawn` or `worker.spawn`. Non-parallel programs save ~450 lines of generated C code.

**Synchronous system helpers** (stat/dirent accessors, sendfile/copyfile, sync file operations, mmap/madvise, fcntl, flock, socket address helpers, signal handlers, TTY) are always emitted via `generateSysRuntime()` which includes both cross-platform helpers and platform-specific sync helpers (`generatePlatformSysRuntime{MacOS,Linux,Windows}`). These have **no IoFuture dependency**. All functions are `static`, so unused ones are stripped by the C compiler's dead-code elimination. This ensures non-async programs that use signals, stat, mmap, TTY, etc. compile without pulling in the full async runtime.

### Platform-Specific I/O Backends

| Platform | Backend                                         | File                    |
| -------- | ----------------------------------------------- | ----------------------- |
| Linux    | `io_uring` (via liburing)                       | `runtime-io-linux.ts`   |
| macOS    | `kqueue` (kevent readiness + sync pread/pwrite) | `runtime-io-macos.ts`   |
| Windows  | I/O Completion Ports (IOCP)                     | `runtime-io-windows.ts` |
| WASM     | POSIX I/O (NODERAWFS) + timer queue             | `runtime-io-wasm.ts`    |

#### WASM Async Support

WASM targets (`wasm32-emscripten` via emcc) support the core async scheduler with real timer support — `io.async()`, `io.await()`, `io.spawn()`, `JoinHandle.await()`, and `sleep()` (from `std/sys/timer`) all work. The scheduler runs with POSIX I/O via NODERAWFS for file operations, and a sorted timer queue for non-blocking sleep.

What works on WASM:

- `io.async()` — create lazy futures
- `io.await()` — await futures
- `io.spawn()` / `JoinHandle.await()` — spawn and join tasks
- `yield()` — cooperative yielding between tasks
- Algebraic effects with async
- `sleep()` (from `std/sys/timer`) — timer-based delays via sorted timer queue
- File I/O (`File.open`, `read`, `write` from `std/fs/file` and `std/sys/file`) — via NODERAWFS (Node.js) or Emscripten FS

What does NOT work on WASM:

- DNS, TCP, UDP — no network stack in Emscripten
- Process spawn, signals, FS events — no OS-level APIs
- Parallelism (`Thread.spawn`) — requires pthread support (experimental)

Concurrency helpers return sensible defaults: `__yo_thread_get_hardware_threads()` returns 1, `__yo_get_thread_id()` returns 0, `__yo_thread_yield()` is a no-op.

## Memory Management

### Non-Atomic Reference Counting

Since all async code runs on one thread:

- No atomic operations needed for RC
- Simple increment/decrement
- No synchronization overhead

```c
// Non-atomic RC (single-threaded)
struct __yo_ref_header {
  size_t ref_count;  // Simple size_t, not atomic!
};

// Increment - no atomics!
static inline void yo_rc_inc(__yo_ref_header_t* header) {
  header->ref_count++;
}

// Decrement - no atomics!
static inline bool yo_rc_dec(__yo_ref_header_t* header) {
  return --header->ref_count == 0;
}
```

### Future Lifetime Management

Futures (async block state machines) are **reference counted** to handle cases where tasks complete before being awaited:

**Lifetime Pattern: "Event Loop Holds References"**

```rust
main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io)=> {
    /* work */
  });
  // task is cold (refcount=1), hasn't started yet

  io.spawn(task);
  // spawn starts task, returns JoinHandle(T) (non-owning view)
  // __yo_incr_rc (refcount=2)
  // One reference for user code (task), one for running task (event loop)

  io.await(task);
  // Waits for completion, extracts result
  // Task completes, event loop drops reference (refcount=1)
  // task goes out of scope (refcount=0, freed)
});
export main;
```

**Refcount Lifecycle:**

1. **Creation**: `io.async(fn)` allocates state machine, `refcount = 1`
2. **Start (via await/spawn)**: `__yo_incr_rc()` before starting (refcount = 2)
   - One reference for user code (the `task` variable)
   - One reference for the running task (held by event loop)
3. **User Drop**: When `task` goes out of scope, `__yo_decr_rc()` (refcount = 1)
4. **Task Completion**: State machine calls `__yo_decr_rc()` (refcount = 0, freed)

**Key Insight**: Tasks stay alive until completion even if user code drops them early!

**Implementation Details:**

The state machine struct includes a `__yo_ref_header_t` as its first field:

```c
struct async_block_state_t {
  __yo_ref_header_t header;  // Must be first for __yo_decr_rc to work
  int state;
  // ... other fields ...
};
```

The `Impl(Future(T))` type uses `__yo_sometype_drop` which calls `__yo_decr_rc`:

```c
void fn_id12345___drop(async_block_state_t* self) {
  if (self != NULL) { __yo_decr_rc((void*)self); };
}
```

**Type System Integration:**

The evaluator's `getMethodsByNameFromEnv` function has special handling for Future types - it does NOT use the `resolvedConcreteType` for method lookup. This ensures that when calling `task.___drop()`, it uses the SomeType's own `___drop` method which calls `__yo_sometype_drop`, rather than using the capture struct's drop function.

### State Machine Lifecycle

```c
// 1. Creation — allocate Future with state machine (cold, refcount=1)
FunctionName_Future* future = __yo_malloc(sizeof(FunctionName_Future));
future->header.ref_count = 1;
future->state = 0;  // Cold — not started
// Initialize state machine fields...

// 2. Start (lazy) — triggered by io.await or io.spawn
__yo_incr_rc(future);  // refcount = 2
future->__yo_resume_fn(future);  // Runs until first yield/await
// Task suspends at yield, gets queued in event loop

// 3. Event loop — runs ready tasks
while (not_complete) {
  __yo_async_run_ready_tasks();  // Resumes queued tasks
}

// 4. Completion
future->state = -1;  // Mark as completed
future->result = final_value;
__yo_decr_rc(future);  // Release running task reference
// Wake continuation (if any)

// 5. Cleanup — when user drops, refcount reaches 0, freed
```

### `Impl(Future(T))` Dispatch and Allocation Model

**`Impl(Future(T))` is always heap-allocated with non-atomic reference counting.**

This is **not** static dispatch (where the concrete type is known and stack-allocated). Instead:

1. **Heap allocation**: `io.async(fn)` calls `__yo_malloc(sizeof(state_machine_struct))` and returns a pointer. This is necessary because:

   - Futures suspend and resume across C stack frames — the state machine must outlive the frame that created it
   - The event loop queues continuations as `(resume_fn, state_machine_ptr)` pairs — stable addresses are required
   - Multiple references (user code + event loop) can exist simultaneously

2. **Reference counting**: Each state machine has a `__yo_ref_header_t` as its first field. The RC is non-atomic because all async code runs on a single thread. The typical lifecycle is:

   - Creation: `refcount = 1` (user owns)
   - Start (await/spawn): `refcount = 2` (user + event loop)
   - Task completion: event loop decrements → `refcount = 1`
   - User scope exit: user decrements → `refcount = 0` → freed via dispose function

3. **Pointer semantics**: In generated C code, `Impl(Future(T))` compiles to `state_machine_struct*` (a pointer). The Yo type system treats it as opaque — user code cannot inspect the struct fields.

4. **Dispose function**: Each state machine type gets a custom dispose function that:

   - Drops the capture struct (outer scope variables)
   - Drops the result value (if completed and result contains RC types)
   - Drops local variables (if aborted mid-execution)
   - The memory is freed by `__yo_decr_rc` after the dispose function returns

5. **sync_fut_t optimization**: When an async block has **no await points** (purely synchronous), a lightweight `sync_fut_t` struct is generated instead of a full state machine. It has the same header layout but no state dispatch — the resume function simply calls the closure and sets state to -1 (completed).

**Why not stack allocation?** Even with `Impl(...)` (which typically implies static dispatch in Yo), Futures must be heap-allocated because their lifetime is decoupled from the creating stack frame. A future created in function `f()` may be awaited in function `g()` after `f()` has returned.

### State Machine Memory

State machines are small (~32-500 bytes):

- State ID: 4 bytes
- Captured parameters: varies
- Captured locals: varies
- Pending Futures: 8 bytes each

## Performance Characteristics

### Memory Usage

**10,000 concurrent async operations:**

- State machines: 10,000 × ~200 bytes = 2MB
- No thread stacks needed!

**Comparison:**

- 10,000 OS threads × 1MB stack = 10GB ❌
- 10,000 Go goroutines × 2KB = 20MB
- 10,000 Yo async tasks × 200 bytes = 2MB ✅

### Throughput

- State machine poll: ~10-50ns per poll
- No context switching (same thread)
- No synchronization overhead
- Cache-friendly (small state machines)

## API

### Core Operations

```rust
{ yield } :: import "std/async";

// io.async: Create a lazy Future (cold, doesn't start until awaited/spawned)
task := io.async((io : Io)=> {
  // body
  return value;
});

// io.await: Start if cold, wait for completion, return result
result := io.await(task);

// io.spawn: Start a cold Future without waiting, returns JoinHandle(T)
handle1 := io.spawn(task1);
handle2 := io.spawn(task2);
// After spawn, tasks are running — handle.await returns Option(T)
r1 := handle1.await(io);
r2 := handle2.await(io);
```

### Example: Concurrent Tasks with Spawn

```rust
{ yield } :: import "std/async";

main :: (fn(io : Io) -> unit)({
  counter := Box(i32)(0);

  task1 := io.async((io : Io)=> {
    counter.* = (counter.* + 1);
    io.await(yield());
    counter.* = (counter.* + 1);
    return counter.*;
  });

  task2 := io.async((io : Io)=> {
    counter.* = (counter.* + 10);
    io.await(yield());
    counter.* = (counter.* + 10);
    return counter.*;
  });

  // Tasks are cold — counter is still 0
  handle1 := io.spawn(task1);
  handle2 := io.spawn(task2);
  // Both run via interleaved execution: counter = 22
  result1 := handle1.await(io);
  result2 := handle2.await(io);
});
export main;
```

### Example: Sequential Await (No Spawn)

```rust
{ yield } :: import "std/async";

main :: (fn(io : Io) -> unit)({
  counter := Box(i32)(0);

  task1 := io.async((io : Io)=> {
    counter.* = (counter.* + 1);
    io.await(yield());
    counter.* = (counter.* + 1);
  });

  task2 := io.async((io : Io)=> {
    counter.* = (counter.* + 10);
    io.await(yield());
    counter.* = (counter.* + 10);
  });

  // Without spawn: tasks run sequentially
  io.await(task1);  // task1 runs fully to completion
  io.await(task2);  // then task2 runs fully to completion
  // counter = 22 either way, but no interleaving
});
export main;
```

## Comparison with Other Languages

| Language                            | Model                    | Threading           | Memory/Task | Max Concurrency |
| ----------------------------------- | ------------------------ | ------------------- | ----------- | --------------- |
| **Yo**                              | Stackless state machines | **Single-threaded** | ~200 bytes  | Millions        |
| **JavaScript**                      | Stackless promises       | **Single-threaded** | ~100 bytes  | Millions        |
| **Python (asyncio)**                | Stackless coroutines     | **Single-threaded** | ~200 bytes  | Millions        |
| **Rust (single-threaded executor)** | Stackless futures        | **Single-threaded** | ~100 bytes  | Millions        |
| **Rust (tokio multi-threaded)**     | Stackless futures        | Multi-threaded      | ~100 bytes  | Millions        |
| **Go**                              | Stackful goroutines      | Multi-threaded      | 2KB+        | 100K-1M         |

**Note**: Yo's single-threaded async is most similar to JavaScript and Python asyncio:

- ✅ Simple mental model (no thread safety)
- ✅ No Send/Sync traits needed
- ✅ No atomic RC overhead
- ✅ Familiar to web developers

For parallelism, use `Task.spawn` (see `PARALLELISM.md`).

## Effect Injection (Runtime Effect Binding)

When an async closure declares effect parameters via `e : E`, the handlers
may not be known at `io.async` creation time. Yo supports **runtime effect
injection**: the caller supplies concrete handlers at `io.spawn` or `io.await`
time, and they are bound into the future's capture struct. `io.spawn` returns a `JoinHandle(T)` which can be awaited via `handle.await(io)` returning `Option(T)`.

### When Is Runtime Injection Used?

An effect parameter becomes a runtime `void*` field in the capture struct when
**all** of the following are true:

1. The parameter is **function-typed** (not a module like `Io`)
2. The function type has **no `generic` parameters** (generic effects like
   `fn(generic(T : Type), ...) -> T` are resolved at compile time instead)
3. The handler is **not already resolved** at `io.async` creation time (no
   `(name : Type) = handler` binding in the outer scope)

If the handler IS available at creation time (via a `given` binding), it is
resolved at compile time and the parameter remains compile-time only.

### Set-Once Semantics

Effect injection follows **set-once** semantics. The first `io.spawn` or
`io.await` call that transitions a future from pending (state 0) to running
binds the effect handlers. Subsequent calls to `io.spawn`/`io.await` with
different `e : E` arguments have no effect — the original handlers are
retained.

```rust
Log :: (fn(msg : String) -> unit);

task := io.async((io : Io, log : Log)=> {
  log(`hello`);
});

(log1 : Log) = (msg) -> { println(`Log1: ${msg}`); };
(log2 : Log) = (msg) -> { println(`Log2: ${msg}`); };

// First spawn binds log1 as the handler, returns JoinHandle
handle := io.spawn(task, io, log1);

// handle.await uses the already-bound handlers
handle.await(io);
// Output: "Log1: hello"
```

### How It Works (Implementation)

1. **Evaluator**: Function-typed `using` parameters that are unresolved at
   `io.async` time are added to the closure's `capturedVariablesWithValues`
   with `isEffectParam: true` and `value: undefined`.

2. **Capture struct**: Effect param fields are typed as `void*` in C and
   NULL-initialized when the future is created.

3. **Injection at spawn/await**: When `io.spawn(task, ...)` or
   `io.await(task, ...)` is called and the future is still cold
   (state == 0), the codegen emits assignments like:

   ```c
   future->__capture.log = (void*)fn_handler;
   ```

4. **Calling through void\***: Inside the async closure body, calls to effect
   parameters go through a function pointer cast:
   ```c
   ((return_type (*)(param_types...))sm->__capture.log)(args);
   ```

### Compile-Time vs Runtime Effects

| Condition                        | Resolution        | C representation      |
| -------------------------------- | ----------------- | --------------------- |
| `handler` in scope at `io.async` | Compile-time      | Direct function call  |
| Generic effect (`generic(T)`)    | Compile-time      | Direct function call  |
| Non-module (`Io`) type           | Compile-time      | No runtime field      |
| Non-generic, unresolved handler  | Runtime injection | `void*` capture field |

## Async + Algebraic Effects

Algebraic effects and async work together: async closures can declare effect
parameters via `e : E`, and callers inject handlers at `io.await` or
`io.spawn` time. This section covers tested scenarios and known limitations.

### Tested Scenarios

| Scenario                                    | Description                                                  |
| ------------------------------------------- | ------------------------------------------------------------ |
| Effect resume inside async closure          | Handler `return`s a value, async closure receives it         |
| Effect resume across multiple yields        | Effect called after each `io.await(yield())`                 |
| Two effects injected via `io.await`         | Two independent effect handlers injected together            |
| Two effects injected via `io.spawn`         | Same, but via `io.spawn` + `handle.await`                    |
| Effect resume in async while loop           | Effect called inside `while` loop body with yields           |
| Effect resume in while loop with break      | Effect triggers `break` based on return value                |
| Escape via injected effect aborts future    | Handler `unwind`s, future enters `Aborted` state             |
| JoinHandle unwind via spawn-injected effect | Same but with `io.spawn`, `handle.await` returns `.None`     |
| Given handler inside async with yields      | `given` binding defined inside async body, used after yields |

### Known Limitations

1. **Effect handlers are not closures** — handler functions are standalone C
   functions and cannot capture variables from the enclosing scope. Pass state
   via explicit parameters or `Box`. See `docs/en-US/ALGEBRAIC_EFFECTS.md`.

2. **Async unwind RC double-decrement** — when a future is passed as a
   parameter to a function that escapes during `io.await`, the future's RC is
   decremented twice (once in the await abort path, once in unwind cleanup),
   causing use-after-free. Workaround: create the future inside the escaping
   function. See `issues/async-unwind-rc-double-decrement.md`.

3. **3-argument while loop in async** — the async SM codegen only handles the
   2-argument form `while condition, body`. The 3-argument form
   `while condition, step, body` emits broken C code. Workaround: put the step
   expression inside the loop body. See `issues/async-while-3arg-form.md`.

4. **Binary expression as async return value** — when the last expression in an
   async closure is a binary operation (e.g., `(a + b)`), the SM struct gets
   `void* result` instead of the correct type. Workaround: assign to a variable
   first. See `issues/async-sm-result-type-binary-expr.md`.

## Summary

Yo's async/await provides:

1. **Lazy execution** — `io.async(fn)` creates cold Futures that don't start until `io.await` or `io.spawn`
2. **Single-threaded concurrency** — all async runs on one thread
3. **Concurrent spawn** — `io.spawn(f)` starts a cold Future without waiting, returns `JoinHandle(T)`
4. **No thread safety concerns** — no data races possible
5. **Algebraic effects** — Io capabilities explicit via `io : Io`
6. **State machine transformation** — zero-cost abstraction
7. **Non-atomic RC** — no synchronization overhead
8. **Memory efficient** — millions of concurrent tasks (~200 bytes each)
9. **Fairness** — yield points ensure tasks interleave correctly
10. **Zero-cost** — compiled to efficient C code

### Quick Reference

```rust
{ yield } :: import "std/async";

// Create lazy async task
task := io.async((io : Io)=> {
  io.await(yield());  // Yield to event loop
  return i32(42);
});

// Sequential: start and run to completion
result := io.await(task);

// Concurrent: start tasks without waiting, then await handles
handle1 := io.spawn(task1);
handle2 := io.spawn(task2);
r1 := handle1.await(io);  // Option(T)
r2 := handle2.await(io);  // Option(T)
```

### Key Principles

1. **Lazy execution** — `io.async(fn)` creates cold Futures
2. **`io.await(task)`** — starts cold task, runs sequentially to completion
3. **`io.spawn(task)`** — starts cold task without waiting, returns `JoinHandle(T)`
4. **`handle.await(io)`** — waits for spawned task, returns `Option(T)` (`.None` on unwind)
5. **Single-threaded** — all async code runs on the calling thread
6. **`yield()` yields** — suspends task, gives control to other ready tasks
7. **State machines** — compiler transforms each `io.await` into state transition
8. **No thread safety** — no Send trait, no data races
9. **Non-atomic RC** — simple reference counting (no synchronization)
10. **Event loop** — runs ready tasks, checks Io completion
11. **Zero-cost** — compiled to efficient C code

### When to Use What

| Use Case                       | Mechanism                         |
| ------------------------------ | --------------------------------- |
| Io-bound concurrent tasks      | `io.async`/`io.await`             |
| Running multiple tasks at once | `io.spawn` + `handle.await`       |
| CPU-bound parallel computation | `Task.spawn` (see PARALLELISM.md) |
| Background processing          | `Task.spawn` (see PARALLELISM.md) |
| Waiting for multiple IOs       | `io.spawn` + `handle.await`       |
| Utilizing multiple CPU cores   | `Task.spawn` (see PARALLELISM.md) |
