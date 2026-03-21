# Async/Await - Single-Threaded Concurrency for Yo

## Philosophy

Yo uses **async/await with state machine transformation** via **algebraic effects** for efficient **single-threaded concurrency**. This is a stackless coroutine model similar to JavaScript's event loop - all async code runs on the **same thread** as the caller.

**Key Insight**: `io.async`/`io.await` provides **concurrency** (interleaved execution), not **parallelism** (simultaneous execution). For parallelism, see `PARALLELISM.md` which describes the `Task.spawn` API for isolated multi-threaded execution.

```rust
{ yield } :: import "std/async";

// All async code runs on the SAME thread
main :: (fn(using(io : IO)) -> unit)({
  task1 := io.async((using(io : IO))=> {
    io.await(yield());
    return i32(1);
  });
  task2 := io.async((using(io : IO))=> {
    io.await(yield());
    return i32(2);
  });
  // spawn starts both without waiting, returning JoinHandles
  handle1 := io.spawn(task1);
  handle2 := io.spawn(task2);
  // await on handles and extract results (Option(T))
  result1 := handle1.await(using(io));
  result2 := handle2.await(using(io));
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
main :: (fn(using(io : IO)) -> unit)({
  a := io.async((using(io : IO))=> { /* ... */ });
  b := io.async((using(io : IO))=> { /* ... */ });
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

Yo's async uses **algebraic effects** with the `IO` effect type. Async tasks are **lazy** — they don't start until explicitly awaited or spawned:

- `io.async(fn)` creates a **cold Future** — the function body is NOT executed yet
- `io.await(task)` starts a cold task and runs it to completion (sequential)
- `io.spawn(task)` starts a cold task **without waiting** for it to complete, returns `JoinHandle(T)`

```rust
{ yield } :: import "std/async";

main :: (fn(using(io : IO)) -> unit)({
  counter := Box(i32)(0);

  // Lazy creation — neither task starts yet
  task1 := io.async((using(io : IO))=> {
    counter.* = (counter.* + 1);   // Runs when started
    io.await(yield());              // Yields to event loop
    counter.* = (counter.* + 1);   // Resumes after other tasks yield
  });

  task2 := io.async((using(io : IO))=> {
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
  handle1.await(using(io));
  handle2.await(using(io));

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
8. **Algebraic Effects**: IO capabilities are explicit via `using(io : IO)`

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
task := io.async((using(io : IO))=> {
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
r1 := handle1.await(using(io));
r2 := handle2.await(using(io));
r3 := handle3.await(using(io));
```

### IO Effect and Using

Async operations require the `IO` effect, passed via `using(io : IO)`:

```rust
// Main function receives IO effect
main :: (fn(using(io : IO)) -> unit)({
  task := io.async((using(io : IO))=> {
    // Can use io.await, io.async, io.spawn here
    io.await(yield());
  });
  io.await(task);
});
export main;

// Test blocks also receive IO effect
test "my test", using(io : IO), {
  task := io.async((using(io : IO))=> { /* ... */ });
  io.await(task);
};
```

### API

```rust
io.async(fn)                  // Create a cold Future (lazy, doesn't start)
io.await(future)              // Start if cold, wait for completion, return result
io.state(future)              // Query the current state of a Future (returns FutureState)
io.spawn(future)              // Start a cold Future without waiting, returns JoinHandle(T)
handle.await(using(io))       // Wait for spawned task, returns Option(T) (.None on escape)
yield()                       // Create a pre-completed Future (yields control to event loop)
```

**Important Rules**:

1. `io.async(fn)` creates a **lazy** Future — the function body does NOT execute until awaited or spawned
2. `io.await(future)` starts a cold future and runs it sequentially to completion
3. `io.state(future)` returns the current `FutureState` without blocking or starting the Future
4. `io.spawn(future)` starts a cold future without waiting — returns `JoinHandle(T)` for later awaiting
5. `handle.await(using(io))` waits for a spawned task and returns `Option(T)` — `.Some(result)` on completion, `.None` on escape (abort)
6. Spawning an already **aborted** Future causes a **panic**
7. All async code runs on the **same thread** — no thread spawning
8. `yield()` suspends the current task and yields to other ready tasks in the event loop
9. `io.await(future)` can be called **multiple times** on the same Future — each call returns the same result
10. Awaiting a Future that was **aborted** by an algebraic effect handler causes a **panic**

### Execution Model

```rust
// All three tasks run on the SAME thread
main :: (fn(using(io : IO)) -> unit)({
  // LAZY — tasks are cold, nothing runs yet
  t1 := io.async((using(io : IO))=> { /* task1 body */ });
  t2 := io.async((using(io : IO))=> { /* task2 body */ });
  t3 := io.async((using(io : IO))=> { /* task3 body */ });

  // spawn starts each task without waiting:
  // - t1 runs until first yield, suspends
  // - t2 runs until first yield, suspends
  // - t3 runs until first yield, suspends
  h1 := io.spawn(t1);
  h2 := io.spawn(t2);
  h3 := io.spawn(t3);

  // handle.await waits for completion and returns Option(T):
  // - event loop resumes t1, t2, t3 in round-robin
  r1 := h1.await(using(io));
  r2 := h2.await(using(io));
  r3 := h3.await(using(io));
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

`Future(T)` can carry algebraic effect information. The full syntax is:

```rust
Future(T)                                  // No effects
Future(T, ...(E))                          // Effect row spread (E must be forall-declared)
Future(T, Raise)                           // Single individual effect
Future(T, Raise, Log)                      // Multiple individual effects
Future(T, Raise, ...(E))                   // Mixed: individual effects + one row spread
```

Each argument after the output type `T` is either:

- An **individual effect type** (e.g., `Raise`, `Log`) — evaluated as a type expression
- An **effect row spread** `...(E)` — where `E` must be a forall-declared effect row variable

**Simplification rules:**

- `...(E)` is ONLY allowed when `E` is a single forall-declared effect row variable
- For concrete effects, list them directly: `Future(T, Raise, Log)` not `Future(T, ...(Raise, Log))`
- At most one unsolved spread variable during type unification

**Effect Matching Rules:**

1. **Order-independent (set-based):** Effects are compared as sets, not ordered lists. `Future(i32, Raise, Log)` matches `Future(i32, Log, Raise)`.
2. **Spread flattening:** `...(E)` where E resolves to `{Raise, Log}` is equivalent to listing `Raise, Log` individually. `Future(i32, ...(E))` matches `Future(i32, Raise, Log)` after flattening.
3. **Backward compatibility:** `Future(T)` (no effects) is compatible with any `Future(T, ...)` for backward compatibility.
4. **IO is always present:** Since `io.async` closures always need `IO` for `io.await`/`yield`, the Future type from `io.async` always includes `IO` in its effects.

**Example: Effect propagation through async**

```rust
{ yield } :: import "std/async";
Raise :: (fn(forall(T : Type), msg : String) -> T);
Log :: (fn(msg : String) -> unit);

main :: (fn(using(io : IO)) -> unit)({
  // Define effect handlers in the caller scope
  (given(raise) : Raise) = ((msg) -> {
    return i32(0);
  });
  (given(log) : Log) = ((msg) -> {
    println(msg);
  });

  // Closure propagates IO, Raise, Log from the caller
  // Future type becomes Future(i32, IO, Raise, Log)
  task := io.async((using(io : IO, raise : Raise, log : Log))=> {
    log(`doing work`);
    io.await(yield());
    i32(42)
  });

  // io.await resolves IO, Raise, Log from the caller's scope
  result := io.await(task);
});
export main;
```

**Example: Effect-polymorphic async function**

```rust
Raise :: (fn(forall(T : Type), msg : String) -> T);
Log :: (fn(msg : String) -> unit);

// Function that combines two effect-polymorphic functions
run_both :: (fn(
    forall(T1 : Type, T2 : Type, ...(E1), ...(E2)),
    f1 : (fn(using(...(E1))) -> T1),
    f2 : (fn(using(...(E2))) -> T2),
    using(...(E1), ...(E2))
  ) -> T1)
{
  f2();
  f1()
};
```

The IO module signatures use effect rows to propagate algebraic effects through async boundaries:

```rust
IO :: module(
  async : (fn(forall(T : Type, ...(E)), action : Impl(Fn(using(...(E))) -> T)) -> Impl(Future(T, ...(E)))),
  await : (fn(forall(T : Type, ...(E)), fut : Impl(Future(T, ...(E))), using(...(E))) -> T),
  state : (fn(forall(T : Type, ...(E)), fut : Impl(Future(T, ...(E)))) -> FutureState),
  spawn : (fn(forall(T : Type, ...(E)), fut : Impl(Future(T, ...(E))), using(...(E))) -> JoinHandle(T))
);
```

Why heap allocation?

- A Future can suspend at an `await` and resume later; the state machine must have a stable address after the current C stack frame returns.
- The runtime queues continuations as `(resume_fn, state_machine_ptr)`, so the state machine must outlive the scheduling point.

This is an implementation choice, not a semantic requirement.

### Multi-Await

A Future can be awaited **multiple times**. Each `io.await` call on the same Future returns the same result:

```rust
main :: (fn(using(io : IO)) -> unit) {
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

When an algebraic effect handler calls `escape` inside an async task, the Future is marked as **aborted** (internal state = -2). The task's continuation is discarded and no result is stored.

**With `io.await`**: Attempting to `io.await` on an aborted Future causes a **panic**.

**With `handle.await`**: `JoinHandle.await` returns `Option(T)` — `.None` on abort, safely catching the escape:

```rust
main :: (fn(using(io : IO)) -> unit) {
  Raise :: (fn(forall(T : Type), msg : String) -> T);
  task := io.async((using(io : IO, raise : Raise)) => {
    raise(`something went wrong`);
    return i32(42);
  });

  (given(raise) : Raise) = (msg) -> { escape (); };
  handle := io.spawn(task, using(io, raise));
  result := handle.await(using(io));
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
| -2    | Aborted — an effect handler called `escape`, no result | `FutureState.Aborted`   |

### Querying Future State

`io.state(future)` returns the current `FutureState` without blocking or starting the Future. This is useful for polling or diagnostics:

```rust
FutureState :: enum(
  Pending = 0,     // Cold — not started yet
  Running = 1,     // In progress — suspended at an await/yield point
  Completed = -(1), // Completed — result is available
  Aborted = -(2)   // Aborted — an effect handler called escape
);
```

```rust
main :: (fn(using(io : IO)) -> unit) {
  task := io.async((using(io : IO))=> {
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
task := io.async((using(io : IO))=> {
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
│  │   - If IO pending, register waker   │    │
│  │   - If ready, continue              │    │
│  └─────────────────────────────────────┘    │
│                    │                        │
│                    ▼                        │
│  ┌─────────────────────────────────────┐    │
│  │         IO Completion Check         │    │
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
3. **If await on pending IO**: Register waker, task sleeps
4. **If await on ready Future**: Continue to next state
5. **If complete**: Mark Future as ready, wake awaiters
6. **Check IO**: Poll OS for completed IO events
7. **Wake tasks**: Move woken tasks to ready queue
8. **Repeat** until all tasks complete

### Thread-Local Event Loop

Each thread has its own event loop via thread-local storage:

```c
// Thread-local async runtime state
static __thread yo_async_task_queue_t yo_thread_async_queue = {NULL, NULL, 0};
```

This means:

- **Main thread**: Has its own event loop for `io.async`/`io.await` tasks
- **Worker threads** (from `Task.spawn`): Each gets an independent event loop
- **No cross-thread task migration**: Tasks always run on the thread that created them
- **No locking needed**: Queue operations are single-threaded by design

### Runtime Initialization

The async runtime is generated conditionally — **only when the program uses async/await**:

- The compiler tracks whether any `io.async` blocks or async functions exist
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

**Synchronous system helpers** (stat/dirent accessors, sendfile/copyfile, sync file operations, signal handlers, TTY) are always emitted via `generateSysRuntime()` and have **no IOFuture dependency**. All functions are `static`, so unused ones are stripped by the C compiler's dead-code elimination. This ensures non-async programs that use signals, stat, TTY, etc. compile without pulling in the full async runtime.

### Platform-Specific I/O Backends

| Platform | Backend                           | File                    |
| -------- | --------------------------------- | ----------------------- |
| Linux    | `io_uring` (via liburing)         | `runtime-io-linux.ts`   |
| macOS    | Grand Central Dispatch (GCD)      | `runtime-io-macos.ts`   |
| Windows  | I/O Completion Ports (IOCP)       | `runtime-io-windows.ts` |
| WASM     | No I/O runtime (computation only) | —                       |

## Memory Management

### Non-Atomic Reference Counting

Since all async code runs on one thread:

- No atomic operations needed for RC
- Simple increment/decrement
- No synchronization overhead

```c
// Non-atomic RC (single-threaded)
struct yo_ref_header {
  size_t ref_count;  // Simple size_t, not atomic!
};

// Increment - no atomics!
static inline void yo_rc_inc(yo_ref_header_t* header) {
  header->ref_count++;
}

// Decrement - no atomics!
static inline bool yo_rc_dec(yo_ref_header_t* header) {
  return --header->ref_count == 0;
}
```

### Future Lifetime Management

Futures (async block state machines) are **reference counted** to handle cases where tasks complete before being awaited:

**Lifetime Pattern: "Event Loop Holds References"**

```rust
main :: (fn(using(io : IO)) -> unit)({
  task := io.async((using(io : IO))=> {
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

The state machine struct includes a `yo_ref_header_t` as its first field:

```c
struct async_block_state_t {
  yo_ref_header_t header;  // Must be first for __yo_decr_rc to work
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
  yo_async_run_ready_tasks();  // Resumes queued tasks
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

2. **Reference counting**: Each state machine has a `yo_ref_header_t` as its first field. The RC is non-atomic because all async code runs on a single thread. The typical lifecycle is:

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
task := io.async((using(io : IO))=> {
  // body
  return value;
});

// io.await: Start if cold, wait for completion, return result
result := io.await(task);

// io.spawn: Start a cold Future without waiting, returns JoinHandle(T)
handle1 := io.spawn(task1);
handle2 := io.spawn(task2);
// After spawn, tasks are running — handle.await returns Option(T)
r1 := handle1.await(using(io));
r2 := handle2.await(using(io));
```

### Example: Concurrent Tasks with Spawn

```rust
{ yield } :: import "std/async";

main :: (fn(using(io : IO)) -> unit)({
  counter := Box(i32)(0);

  task1 := io.async((using(io : IO))=> {
    counter.* = (counter.* + 1);
    io.await(yield());
    counter.* = (counter.* + 1);
    return counter.*;
  });

  task2 := io.async((using(io : IO))=> {
    counter.* = (counter.* + 10);
    io.await(yield());
    counter.* = (counter.* + 10);
    return counter.*;
  });

  // Tasks are cold — counter is still 0
  handle1 := io.spawn(task1);
  handle2 := io.spawn(task2);
  // Both run via interleaved execution: counter = 22
  result1 := handle1.await(using(io));
  result2 := handle2.await(using(io));
});
export main;
```

### Example: Sequential Await (No Spawn)

```rust
{ yield } :: import "std/async";

main :: (fn(using(io : IO)) -> unit)({
  counter := Box(i32)(0);

  task1 := io.async((using(io : IO))=> {
    counter.* = (counter.* + 1);
    io.await(yield());
    counter.* = (counter.* + 1);
  });

  task2 := io.async((using(io : IO))=> {
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

When an async closure declares effect parameters via `using(...)`, the handlers
may not be known at `io.async` creation time. Yo supports **runtime effect
injection**: the caller supplies concrete handlers at `io.spawn` or `io.await`
time, and they are bound into the future's capture struct. `io.spawn` returns a `JoinHandle(T)` which can be awaited via `handle.await(using(io))` returning `Option(T)`.

### When Is Runtime Injection Used?

An effect parameter becomes a runtime `void*` field in the capture struct when
**all** of the following are true:

1. The parameter is **function-typed** (not a module like `IO`)
2. The function type has **no `forall` parameters** (generic effects like
   `fn(forall(T : Type), ...) -> T` are resolved at compile time instead)
3. The handler is **not already resolved** at `io.async` creation time (no
   `given(...)` binding in the outer scope)

If the handler IS available at creation time (via a `given` binding), it is
resolved at compile time and the parameter remains compile-time only.

### Set-Once Semantics

Effect injection follows **set-once** semantics. The first `io.spawn` or
`io.await` call that transitions a future from pending (state 0) to running
binds the effect handlers. Subsequent calls to `io.spawn`/`io.await` with
different `using(...)` arguments have no effect — the original handlers are
retained.

```rust
Log :: (fn(msg : String) -> unit);

task := io.async((using(io : IO, log : Log))=> {
  log(`hello`);
});

(given(log1) : Log) = (msg) -> { println(`Log1: ${msg}`); };
(given(log2) : Log) = (msg) -> { println(`Log2: ${msg}`); };

// First spawn binds log1 as the handler, returns JoinHandle
handle := io.spawn(task, using(io, log1));

// handle.await uses the already-bound handlers
handle.await(using(io));
// Output: "Log1: hello"
```

### How It Works (Implementation)

1. **Evaluator**: Function-typed `using` parameters that are unresolved at
   `io.async` time are added to the closure's `capturedVariablesWithValues`
   with `isEffectParam: true` and `value: undefined`.

2. **Capture struct**: Effect param fields are typed as `void*` in C and
   NULL-initialized when the future is created.

3. **Injection at spawn/await**: When `io.spawn(task, using(...))` or
   `io.await(task, using(...))` is called and the future is still cold
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

| Condition                               | Resolution        | C representation      |
| --------------------------------------- | ----------------- | --------------------- |
| `given(handler)` in scope at `io.async` | Compile-time      | Direct function call  |
| Generic effect (`forall(T)`)            | Compile-time      | Direct function call  |
| Non-module (`IO`) type                  | Compile-time      | No runtime field      |
| Non-generic, unresolved handler         | Runtime injection | `void*` capture field |

## Async + Algebraic Effects

Algebraic effects and async work together: async closures can declare effect
parameters via `using(...)`, and callers inject handlers at `io.await` or
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
| Escape via injected effect aborts future    | Handler `escape`s, future enters `Aborted` state             |
| JoinHandle escape via spawn-injected effect | Same but with `io.spawn`, `handle.await` returns `.None`     |
| Given handler inside async with yields      | `given` binding defined inside async body, used after yields |

### Known Limitations

1. **Effect handlers are not closures** — handler functions are standalone C
   functions and cannot capture variables from the enclosing scope. Pass state
   via explicit parameters or `Box`. See `docs/en-US/ALGEBRAIC_EFFECTS.md`.

2. **Async escape RC double-decrement** — when a future is passed as a
   parameter to a function that escapes during `io.await`, the future's RC is
   decremented twice (once in the await abort path, once in escape cleanup),
   causing use-after-free. Workaround: create the future inside the escaping
   function. See `issues/async-escape-rc-double-decrement.md`.

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
5. **Algebraic effects** — IO capabilities explicit via `using(io : IO)`
6. **State machine transformation** — zero-cost abstraction
7. **Non-atomic RC** — no synchronization overhead
8. **Memory efficient** — millions of concurrent tasks (~200 bytes each)
9. **Fairness** — yield points ensure tasks interleave correctly
10. **Zero-cost** — compiled to efficient C code

### Quick Reference

```rust
{ yield } :: import "std/async";

// Create lazy async task
task := io.async((using(io : IO))=> {
  io.await(yield());  // Yield to event loop
  return i32(42);
});

// Sequential: start and run to completion
result := io.await(task);

// Concurrent: start tasks without waiting, then await handles
handle1 := io.spawn(task1);
handle2 := io.spawn(task2);
r1 := handle1.await(using(io));  // Option(T)
r2 := handle2.await(using(io));  // Option(T)
```

### Key Principles

1. **Lazy execution** — `io.async(fn)` creates cold Futures
2. **`io.await(task)`** — starts cold task, runs sequentially to completion
3. **`io.spawn(task)`** — starts cold task without waiting, returns `JoinHandle(T)`
4. **`handle.await(using(io))`** — waits for spawned task, returns `Option(T)` (`.None` on escape)
5. **Single-threaded** — all async code runs on the calling thread
6. **`yield()` yields** — suspends task, gives control to other ready tasks
7. **State machines** — compiler transforms each `io.await` into state transition
8. **No thread safety** — no Send trait, no data races
9. **Non-atomic RC** — simple reference counting (no synchronization)
10. **Event loop** — runs ready tasks, checks IO completion
11. **Zero-cost** — compiled to efficient C code

### When to Use What

| Use Case                       | Mechanism                         |
| ------------------------------ | --------------------------------- |
| IO-bound concurrent tasks      | `io.async`/`io.await`             |
| Running multiple tasks at once | `io.spawn` + `handle.await`       |
| CPU-bound parallel computation | `Task.spawn` (see PARALLELISM.md) |
| Background processing          | `Task.spawn` (see PARALLELISM.md) |
| Waiting for multiple IOs       | `io.spawn` + `handle.await`       |
| Utilizing multiple CPU cores   | `Task.spawn` (see PARALLELISM.md) |
