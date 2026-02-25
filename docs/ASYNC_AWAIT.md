# Async/Await - Single-Threaded Concurrency for Yo

## Philosophy

Yo uses **async/await with state machine transformation** via **algebraic effects** for efficient **single-threaded concurrency**. This is a stackless coroutine model similar to JavaScript's event loop - all async code runs on the **same thread** as the caller.

**Key Insight**: `io.async`/`io.await` provides **concurrency** (interleaved execution), not **parallelism** (simultaneous execution). For parallelism, see `PARALLELISM.md` which describes the `spawn` API for isolated multi-threaded execution.

```yo
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
  // join starts both, interleaves at yield points, waits for all
  io.join(task1, task2);
  result1 := io.await(task1);
  result2 := io.await(task2);
});
export main;
```

## Concurrency vs Parallelism

| Concept         | Mechanism             | Description                                |
| --------------- | --------------------- | ------------------------------------------ |
| **Concurrency** | `io.async`/`io.await` | Multiple tasks interleaved on ONE thread   |
| **Parallelism** | `spawn`               | Multiple tasks running on SEPARATE threads |

```yo
// Concurrency: Same thread, interleaved execution
main :: (fn(using(io : IO)) -> unit)({
  a := io.async((using(io : IO))=> { /* ... */ });
  b := io.async((using(io : IO))=> { /* ... */ });
  io.join(a, b);  // Start both, interleave at yield points
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

Yo's async uses **algebraic effects** with the `IO` effect type. Async tasks are **lazy** — they don't start until explicitly awaited or joined:

- `io.async(fn)` creates a **cold Future** — the function body is NOT executed yet
- `io.await(task)` starts a cold task and runs it to completion (sequential)
- `io.join(task1, task2, ...)` starts all cold tasks **concurrently**, interleaving them at `yield()` points

```yo
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

  // join starts both and interleaves at yield points:
  // 1. task1 runs: counter=0→1, yields
  // 2. task2 runs: counter=1→11, yields
  // 3. task1 resumes: counter=11→12
  // 4. task2 resumes: counter=12→22
  io.join(task1, task2);

  assert((counter.* == i32(22)), "both tasks interleaved and completed");
});
export main;
```

**Key Difference from Eager Models (old Yo, C#, C++):**

- Eager: `let f = async_fn()` runs immediately until first `await`
- Lazy (current): `task := io.async(fn)` does nothing until `io.await(task)` or `io.join(task)`

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

Yo's approach: Keep async simple (single-threaded), use `spawn` for parallelism (isolated threads).

## Language Syntax

```yo
{ yield } :: import "std/async";

// Async task creation (lazy — doesn't run until awaited/joined)
task := io.async((using(io : IO))=> {
  io.await(yield());  // Yield to event loop
  return i32(42);
});

// Sequential await: starts the task, runs to completion
result := io.await(task);

// Concurrent join: starts multiple tasks, interleaves at yield points
io.join(task1, task2, task3);

// After join, tasks are complete — await just extracts results
r1 := io.await(task1);
r2 := io.await(task2);
r3 := io.await(task3);
```

### IO Effect and Using

Async operations require the `IO` effect, passed via `using(io : IO)`:

```yo
// Main function receives IO effect
main :: (fn(using(io : IO)) -> unit)({
  task := io.async((using(io : IO))=> {
    // Can use io.await, io.async, io.join here
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

```yo
io.async(fn)                  // Create a cold Future (lazy, doesn't start)
io.await(future)              // Start if cold, wait for completion, return result
io.join(f1, f2, ...)          // Start all cold futures, interleave at yield points
yield()                       // Create a pre-completed Future (yields control to event loop)
```

**Important Rules**:

1. `io.async(fn)` creates a **lazy** Future — the function body does NOT execute until awaited or joined
2. `io.await(future)` starts a cold future and runs it sequentially to completion
3. `io.join(f1, f2, ...)` starts all futures concurrently, interleaving execution at `yield()` / `io.await()` suspension points
4. After `io.join` completes, all futures are done — `io.await` on them just extracts results
5. All async code runs on the **same thread** — no thread spawning
6. `yield()` suspends the current task and yields to other ready tasks in the event loop
7. `io.await(future)` can be called **multiple times** on the same Future — each call returns the same result
8. Awaiting a Future that was **aborted** by an algebraic effect handler causes a **panic**

### Execution Model

```yo
// All three tasks run on the SAME thread
main :: (fn(using(io : IO)) -> unit)({
  // LAZY — tasks are cold, nothing runs yet
  t1 := io.async((using(io : IO))=> { /* task1 body */ });
  t2 := io.async((using(io : IO))=> { /* task2 body */ });
  t3 := io.async((using(io : IO))=> { /* task3 body */ });

  // join starts all three, interleaves at yield points:
  // - t1 runs until first yield, suspends
  // - t2 runs until first yield, suspends
  // - t3 runs until first yield, suspends
  // - t1 resumes, runs until next yield or completion
  // - t2 resumes, ...
  // - etc.
  io.join(t1, t2, t3);

  // All complete — extract results
  r1 := io.await(t1);
  r2 := io.await(t2);
  r3 := io.await(t3);
});
```

### Future Type

```yo
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

```yo
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

```yo
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

```yo
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

```yo
IO :: module(
  async : (fn(forall(T : Type, ...(E)), action : Impl(Fn(using(...(E))) -> T)) -> Impl(Future(T, ...(E)))),
  await : (fn(forall(T : Type, ...(E)), fut : Impl(Future(T, ...(E))), using(...(E))) -> T),
  join : (fn(...) -> unit)
);
```

Why heap allocation?

- A Future can suspend at an `await` and resume later; the state machine must have a stable address after the current C stack frame returns.
- The runtime queues continuations as `(resume_fn, state_machine_ptr)`, so the state machine must outlive the scheduling point.

This is an implementation choice, not a semantic requirement.

### Multi-Await

A Future can be awaited **multiple times**. Each `io.await` call on the same Future returns the same result:

```yo
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

When an algebraic effect handler calls `abort` inside an async task, the Future is marked as **aborted** (internal state = -2). The task's continuation is discarded and no result is stored.

Attempting to `io.await` or `io.join` on an aborted Future causes a **panic**:

```yo
main :: (fn(using(io : IO)) -> unit) {
  Raise :: (fn(forall(T : Type), msg : String) -> T);
  task := io.async((using(io : IO))=> {
    (given(raise) : Raise) = ((msg) -> { abort (); });
    raise(`something went wrong`);
    42
  });
  result := io.await(task);  // panic: attempted to await an aborted Future
};
export main;
```

**Future State Machine States:**

| State | Meaning                                               |
| ----- | ----------------------------------------------------- |
| 0     | Cold — not started yet                                |
| 1..N  | Intermediate — suspended at an await/yield point      |
| -1    | Completed — result is available                       |
| -2    | Aborted — an effect handler called `abort`, no result |

## State Machine Transformation

The compiler transforms async functions into state machines at each `await` point.

### Example Transformation

**Input Yo code:**

```yo
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
   - When `io.await` or `io.join` triggers the first resume:
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

```yo
main :: (fn(using(io : IO)) -> unit)({
  task := io.async((using(io : IO))=> {
    /* work */
  });
  // task is cold (refcount=1), hasn't started yet

  io.join(task);
  // join starts task: __yo_incr_rc (refcount=2)
  // One reference for user code (task), one for running task (event loop)
  // Task completes, event loop drops reference (refcount=1)

  io.await(task);
  // Extracts result, task goes out of scope (refcount=0, freed)
});
export main;
```

**Refcount Lifecycle:**

1. **Creation**: `io.async(fn)` allocates state machine, `refcount = 1`
2. **Start (via await/join)**: `__yo_incr_rc()` before starting (refcount = 2)
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
  _Atomic int state;
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

// 2. Start (lazy) — triggered by io.await or io.join
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

```yo
{ yield } :: import "std/async";

// io.async: Create a lazy Future (cold, doesn't start until awaited/joined)
task := io.async((using(io : IO))=> {
  // body
  return value;
});

// io.await: Start if cold, wait for completion, return result
result := io.await(task);

// io.join: Start all cold futures concurrently, interleave at yield points
io.join(task1, task2);
// After join, both tasks are complete
r1 := io.await(task1);  // Just extracts result (already complete)
r2 := io.await(task2);
```

### Example: Concurrent Tasks with Join

```yo
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
  io.join(task1, task2);
  // Both complete via interleaved execution: counter = 22
  result1 := io.await(task1);
  result2 := io.await(task2);
});
export main;
```

### Example: Sequential Await (No Join)

```yo
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

  // Without join: tasks run sequentially
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

For parallelism, use `spawn` (see `PARALLELISM.md`).

## Summary

Yo's async/await provides:

1. **Lazy execution** — `io.async(fn)` creates cold Futures that don't start until `io.await` or `io.join`
2. **Single-threaded concurrency** — all async runs on one thread
3. **Concurrent join** — `io.join(f1, f2, ...)` interleaves tasks at yield points
4. **No thread safety concerns** — no data races possible
5. **Algebraic effects** — IO capabilities explicit via `using(io : IO)`
6. **State machine transformation** — zero-cost abstraction
7. **Non-atomic RC** — no synchronization overhead
8. **Memory efficient** — millions of concurrent tasks (~200 bytes each)
9. **Fairness** — yield points ensure tasks interleave correctly
10. **Zero-cost** — compiled to efficient C code

### Quick Reference

```yo
{ yield } :: import "std/async";

// Create lazy async task
task := io.async((using(io : IO))=> {
  io.await(yield());  // Yield to event loop
  return i32(42);
});

// Sequential: start and run to completion
result := io.await(task);

// Concurrent: interleave multiple tasks at yield points
io.join(task1, task2);
r1 := io.await(task1);
r2 := io.await(task2);
```

### Key Principles

1. **Lazy execution** — `io.async(fn)` creates cold Futures
2. **`io.await(task)`** — starts cold task, runs sequentially to completion
3. **`io.join(f1, f2)`** — starts all, interleaves at yield points, waits for all
4. **Single-threaded** — all async code runs on the calling thread
5. **`yield()` yields** — suspends task, gives control to other ready tasks
6. **State machines** — compiler transforms each `io.await` into state transition
7. **No thread safety** — no Send trait, no data races
8. **Non-atomic RC** — simple reference counting (no synchronization)
9. **Event loop** — runs ready tasks, checks IO completion
10. **Zero-cost** — compiled to efficient C code

### When to Use What

| Use Case                       | Mechanism                    |
| ------------------------------ | ---------------------------- |
| IO-bound concurrent tasks      | `io.async`/`io.await`        |
| Running multiple tasks at once | `io.join`                    |
| CPU-bound parallel computation | `spawn` (see PARALLELISM.md) |
| Background processing          | `spawn` (see PARALLELISM.md) |
| Waiting for multiple IOs       | `io.join` + `io.await`       |
| Utilizing multiple CPU cores   | `spawn` (see PARALLELISM.md) |
