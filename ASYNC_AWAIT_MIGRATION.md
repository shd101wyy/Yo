# Async/Await Value-Type Migration Plan

## Overview

This document describes the migration from reference-counted pointer-based Futures to value-type Futures as described in `ASYNC_AWAIT.md`.

**Current State**: Futures are heap-allocated with `yo_ref_header_t` and passed as pointers.

**Target State**: Futures are value-type structs (state machines) that implement the `Future(T)` trait.

## Key Design Decisions

### 1. Future as Value Type

```c
// OLD: Reference-counted pointer
typedef struct {
  yo_ref_header_t header;           // Reference counting
  _Atomic(yo_future_state_t) state;
  void* state_machine;              // Separate allocation
  void (*resume_fn)(void*);
  // ...
} yo_future_generic_t;

// NEW: Value-type state machine (IS the Future)
typedef struct task1_state_t_struct {
  int state;                        // State machine state
  i32 result;                       // Result value of type T
  capture_struct __capture;         // Captured variables
  // Local variables...
  // Await temporaries...
} task1_state_t;
```

### 2. Async Block Returns Value

```yo
// The async block returns Impl(Future(i32)) - a value type
task1 := async {
  printf("Task 1 started\n");
  return 1;
};
// task1 is a value-type struct, not a pointer
```

### 3. Await Works with Value Types

```c
// OLD: await on pointer
i32 x = yo_await(task1_future_ptr);

// NEW: await on value (passes pointer to stack-allocated value)
task1_state_t task1 = __yo_new_task1(__capture);
// ... later ...
i32 x = yo_await_value(&task1);  // Pass address of value
```

### 4. Runtime Changes - Dual Model: Event Loop + Thread Pool

The async runtime supports two models:

**`async { ... }` - Cooperative tasks on event loop (single-threaded)**
- Uses `yo_async_task()` to queue to main thread event loop
- Cooperative yielding at `await` points
- All tasks share main thread

**`spawn { ... }` - Real parallelism on thread pool (multi-threaded)**  
- Uses `yo_spawn_task()` to dispatch to worker threads
- True parallel execution
- Each task runs on a dedicated thread

**Event Loop + Thread Pool Pseudocode:**
```c
// === Event Loop (for async) ===
yo_continuation_t* async_task_queue_head = NULL;
yo_continuation_t* async_task_queue_tail = NULL;

// Queue a cooperative task (async)
void yo_async_task(void (*resume_fn)(void*), void* state_machine) {
  yo_continuation_t* task = malloc(sizeof(yo_continuation_t));
  task->resume_fn = resume_fn;
  task->state_machine = state_machine;
  task->next = NULL;
  
  if (async_task_queue_tail) {
    async_task_queue_tail->next = task;
  } else {
    async_task_queue_head = task;
  }
  async_task_queue_tail = task;
}

// Run the event loop until all async tasks complete
void yo_run_event_loop() {
  while (async_task_queue_head != NULL) {
    yo_continuation_t* task = async_task_queue_head;
    async_task_queue_head = task->next;
    if (async_task_queue_head == NULL) {
      async_task_queue_tail = NULL;
    }
    
    task->resume_fn(task->state_machine);
    free(task);
  }
}

// === Thread Pool (for spawn) ===
yo_worker_thread_t* worker_threads = NULL;
size_t worker_thread_count = 0;

// Spawn a real parallel task to thread pool
void yo_spawn_task(void (*resume_fn)(void*), void* state_machine) {
  // Find available worker thread
  yo_worker_thread_t* worker = find_available_worker();
  
  // Queue task to worker's queue
  queue_task_to_worker(worker, resume_fn, state_machine);
  
  // Signal worker thread to wake up
  signal_worker(worker);
}

// Await: yield and let event loop run other tasks
void yo_await(Future* future) {
  if (future->state != COMPLETED) {
    return; // Yield to event loop
  }
  // Future is complete, continue
}
```

## Migration Steps

### Phase 1: Type System Updates ✅ (Completed)

1. ✅ Update `getTypeString()` to handle `Impl(Future(T))` as value types
2. ✅ Update `collectType()` to collect `FutureModuleType`
3. ✅ Add `typeImplementsFuture` and `extractFutureModuleFromType` imports
4. ✅ Update `areTypesCompatible()` to check `resolvedConcreteType` for SomeType
5. ✅ Update `getMethodsByNameFromEnv()` to find methods in `resolvedConcreteType`
6. ✅ Update evaluator's `evaluateDrop()` to handle SomeType with `resolvedConcreteType`

### Phase 2: State Machine Struct Generation ✅ (Completed)

1. ✅ Remove `yo_ref_header_t` from state machine struct
2. ✅ Add `result` field directly to struct (not pointer to Future)
3. ✅ Use `typedef struct X_struct { ... } X;` pattern
4. ✅ Register struct name in context.types under FutureModuleType's ID
5. ✅ Generate proper `___drop`, `___dup`, `___dispose` methods for capture struct

### Phase 3: Constructor Generation ✅ (Completed)

1. ✅ Return struct by value instead of pointer
2. ✅ Spawn task immediately - eager evaluation (JavaScript/Python style)
3. ✅ Initialize state to 0 (running)
4. ✅ Copy captured variables into struct

### Phase 4: Resume Function Updates (In Progress)

1. ⬜ Update resume function to work with pointer to value
2. ⬜ Store result in `sm->result` instead of `sm->result->result`
3. ⬜ Update state transitions
4. ⬜ Handle completion (set state to done)

### Phase 5: Await Codegen Updates (TODO)

1. ⬜ Pass pointer to Future value instead of Future pointer
2. ⬜ Poll the state machine directly
3. ⬜ Extract result from `sm.result` after completion
4. ⬜ Handle nested awaits properly

### Phase 6: Drop/Dispose Functions (TODO)

1. ⬜ Generate `___drop` for Future value types
2. ⬜ Drop captured variables properly
3. ⬜ Handle partial completion (task cancelled mid-flight)

### Phase 7: Runtime Updates (TODO)

**Event Loop (for `async`):**
1. ⬜ Implement `yo_async_task()` to queue to event loop (single-threaded)
2. ⬜ Implement `yo_run_event_loop()` to process async task queue
3. ⬜ Update `yo_await_*` to yield to event loop (cooperative)
4. ⬜ Remove atomic operations from event loop path (single-threaded)

**Thread Pool (for future `spawn`):**
1. ⬜ Keep thread pool and worker threads for `spawn`
2. ⬜ Implement `yo_spawn_task()` to dispatch to worker threads (real parallelism)
3. ⬜ Keep atomic operations for thread pool (multi-threaded)

**Both:**
1. ⬜ Update async block constructor to call `yo_async_task()` instead of `yo_spawn_task()`

### Phase 8: Testing & Cleanup (TODO)

1. ⬜ Test basic async/await
2. ⬜ Test captured variables
3. ⬜ Test nested async blocks
4. ⬜ Test multiple awaits
5. ⬜ Remove old reference-counted Future code

## File Changes Required

### `src/codegen/expressions/generation.ts`
- `generateAsyncBlock()` - struct definition, constructor call
- `generateAwait()` - await on value types

### `src/codegen/async/state-machine.ts`
- `generateAsyncBlockResumeFunction()` - resume with value semantics

### `src/codegen/async/runtime.ts`
- Async runtime C code - value-type support

### `src/codegen/types/generation.ts`
- Future type declaration generation

### `src/codegen/functions/generation.ts`
- Drop function generation for Futures

## Implementation Notes

### Dual Concurrency Model

Yo supports two types of concurrency:

#### 1. `async { ... }` - Cooperative Multitasking (Event Loop)

**Single-threaded, cooperative** - like JavaScript/Python async:

```yo
task1 := async { ... };  // Queues to event loop (yo_async_task)
task2 := async { ... };  // Queues to event loop
x := await task1;        // Yields, event loop runs other tasks
y := await task2;        // Yields, event loop runs other tasks
```

- **All tasks run on main thread** 
- **Cooperative** - tasks yield at `await` points
- **Good for**: I/O-bound work, many lightweight tasks
- **Runtime**: Event loop with task queue (`yo_async_task`, `yo_run_event_loop`)

#### 2. `spawn { ... }` - Real Parallelism (Thread Pool)

**Multi-threaded, parallel** - like Rust/Go:

```yo
task1 := spawn { ... };  // Spawns to thread pool (yo_spawn_task)
task2 := spawn { ... };  // Spawns to different thread
x := await task1;        // Waits for completion (may block)
y := await task2;        // Waits for completion (may block)
```

- **Each task runs on worker thread**
- **Parallel** - tasks run simultaneously on different cores
- **Good for**: CPU-bound work, parallel computation
- **Runtime**: Thread pool with work-stealing queues (`yo_spawn_task`, worker threads)

#### Key Differences

| Feature | `async` | `spawn` |
|---------|---------|---------|
| Execution | Single-threaded | Multi-threaded |
| Concurrency | Cooperative (yields) | Parallel (simultaneous) |
| Overhead | Very low | Thread overhead |
| Use case | I/O-bound | CPU-bound |
| Runtime | Event loop | Thread pool |

#### Event Loop Execution Model

```
1. task1 := async { ... }
   → Creates state machine struct
   → Queues task1.resume() to event loop
   → Returns struct by value (task NOT yet executed)

2. task2 := async { ... }
   → Queues task2.resume() to event loop

3. x := await task1
   → Current task yields
   → Event loop runs: task1.resume(), task2.resume(), ...
   → When task1 completes, resume current task
   → Extract result into x

4. y := await task2
   → Current task yields again
   → Event loop continues processing
   → When task2 completes, resume current task
```

#### Constructor Behavior

The async block constructor:
1. Initializes state machine struct with state = 0
2. Copies captured variables (dup Gc types)
3. **Queues** the task to the event loop (doesn't execute yet!)
4. Returns struct by value

The task starts executing when the event loop processes it, not immediately in the constructor.

### Memory Lifetime - Futures are GC'd

**Futures are value types but are GC-managed:**

```c
// Future value types can be:
// 1. On the stack (local variable)
task1_state_t task1 = __yo_new_task1(capture);

// 2. On the heap (boxed, returned from function)
Box_Future_i32 boxed_task = Box(task1);

// 3. Returned by value
Impl_Future_i32 create_task() {
  return async { return 42; };  // Can return Future!
}
```

**Why Futures don't need to stay on caller's stack:**

1. **Captured variables are dup'd** - Future owns its captures via reference counting
2. **Result is stored in Future** - When complete, result lives in the Future struct
3. **Drop cleans up** - When Future is dropped (goes out of scope or GC'd), it drops captures
4. **Can be moved/returned** - Futures can be passed around freely

**Example - Returning a Future:**
```yo
create_async_task :: (fn() -> Impl(Future(i32))) {
  return async {
    printf("Running async task\n");
    return 42;
  };
};

main :: (fn() -> unit) {
  task := create_async_task();  // Future returned by value
  result := await task;          // Await the returned future
  printf("Result: %d\n", result);
};
```

The Future can be returned because:
- It's a value type (copied by value)
- Captured variables are reference counted (dup'd)
- When the Future completes and is dropped, captures are dropped

### Captured Variables

Captured variables are copied into the state machine struct:

```c
typedef struct {
  int state;
  i32 result;
  struct {
    Box_i32* b;  // Captured reference (duped)
  } __capture;
} task1_state_t;
```

The constructor dups the captured Gc types, and drop drops them.

## Event Loop Detailed Design

### Key Concepts

**Continuation**: A task waiting to be executed (resume function + state machine pointer)
**Task Queue**: FIFO queue of continuations
**Yielding**: When a task hits `await` on an incomplete future, it yields control back to the event loop
**Resumption**: When a future completes, tasks waiting on it are re-queued

### Execution Flow Example

```yo
main :: (fn() -> unit) {
  async {
    task1 := async { return 1; };
    task2 := async { return 2; };
    x := await task1;
    y := await task2;
    printf("Done: %d + %d\n", x, y);
  };
  return ();
};
```

**Step-by-step execution:**

1. **Create outer async block** → Queue outer_task to event loop
2. **Event loop runs outer_task.resume()**
   - Executes until `task1 := async { return 1; }`
   - Creates task1 state machine on stack
   - **Queues task1.resume() to event loop**
   - Continues to `task2 := async { return 2; }`
   - **Queues task2.resume() to event loop**
   - Continues to `x := await task1`
   - **task1 not complete yet → yield (return to event loop)**
3. **Event loop runs task1.resume()**
   - Executes `return 1;`
   - Sets task1.result = 1, task1.state = COMPLETED
   - **Re-queue outer_task** (it was waiting on task1)
4. **Event loop runs task2.resume()**
   - Executes `return 2;`
   - Sets task2.result = 2, task2.state = COMPLETED
5. **Event loop runs outer_task.resume()** (from step 3 re-queue)
   - Resumes at `x := await task1` (task1 now complete!)
   - Extracts x = 1
   - Continues to `y := await task2`
   - **task2 is complete → no yield, extract y = 2**
   - Continues to `printf("Done: 1 + 2\n")`
   - Returns → outer_task completes

### Implementation Details

**State Machine State Field:**
```c
typedef enum {
  ASYNC_STATE_0 = 0,    // Initial state
  ASYNC_STATE_1 = 1,    // After first await
  ASYNC_STATE_2 = 2,    // After second await
  // ...
  ASYNC_STATE_COMPLETED = 99  // Task completed
} async_state_t;
```

**Resume Function Structure:**
```c
void task1_resume(task1_state_t* sm) {
  switch (sm->state) {
    case ASYNC_STATE_0:
      // Execute code until first await or return
      // If return: set result, state = COMPLETED, return
      // If await incomplete: increment state, return (yield)
      // If await complete: extract result, continue
      break;
    case ASYNC_STATE_1:
      // Extract await result
      // Continue execution until next await or return
      break;
    // ...
  }
}
```

**Await Implementation:**
```c
// Inside resume function at await point:
if (future->state != COMPLETED) {
  sm->state = next_state;  // Save where to resume
  yo_queue_wait(sm, future);  // Queue this task to be resumed when future completes
  return;  // Yield to event loop
}
// Future is complete, extract result and continue
```

**Constructor Implementation:**
```c
task1_state_t __yo_new_task1(capture_t capture) {
  task1_state_t sm;
  sm.state = 0;
  sm.__capture = capture;  // Copy captured vars (dup Gc refs)
  
  // Queue task to event loop - pointer becomes invalid after return!
  // But that's OK because:
  // 1. The event loop will copy/box the state machine if needed
  // 2. OR the caller stores it on its stack and keeps it alive
  // 3. OR the caller boxes it and it's heap-allocated
  yo_async_task(task1_resume, &sm);
  
  return sm;  // Return by value (copied to caller's stack)
}
```

**✅ No Critical Issue** because:

1. **Caller keeps Future alive** - The Future is stored in a variable on the caller's stack:
   ```c
   task1_state_t task1 = __yo_new_task1(capture);
   // task1 lives on caller's stack until dropped
   ```

2. **Event loop uses the caller's copy** - The queued pointer points to caller's stack
   ```c
   yo_async_task(task1_resume, &sm);  // Points to constructor's stack (temporary)
   // After constructor returns, the COPY on caller's stack is used
   ```

3. **Boxing makes it heap-allocated** - If boxed, it's heap-allocated:
   ```c
   Box_Future_i32* boxed = Box(task1);  // Now on heap, long-lived
   ```

4. **Reference counted captures** - Captured GC types are dup'd:
   ```c
   sm.__capture.b = __yo_dup(capture.b);  // Increment ref count
   // Even if Future is moved/copied, captures stay alive
   ```

**The key insight**: Futures are moveable value types with reference-counted captures, so they can be safely copied, moved, and returned. The event loop always works with pointers to the actual storage location (caller's stack or heap).

## Current Progress

### Completed ✅

Files modified:
- `src/codegen/utils/index.ts` - getTypeString for Impl(Future(T))
- `src/codegen/types/collection.ts` - collectType for Future
- `src/codegen/expressions/generation.ts` - async block struct generation, constructor generation (eager spawning)
- `src/codegen/functions/context.ts` - deferredAsyncBlocks interface
- `src/types/compatibility.ts` - SomeType with resolvedConcreteType support
- `src/env.ts` - Method resolution for SomeType with resolvedConcreteType
- `src/evaluator/builtins/drop.ts` - Drop handling for SomeType with resolvedConcreteType

### Current Status

✅ Basic async/await with value-type Futures is working!
- State machines are value types (no `yo_ref_header_t`)
- Constructor returns struct by value with eager spawning
- Drop methods work correctly for Future value types
- Type system properly handles `Impl(Future(T))` with `resolvedConcreteType`

### Next Steps

1. ⬜ Review and verify resume function for value semantics
2. ⬜ Review and verify await implementation for value types
3. ⬜ Test more complex scenarios (nested async, multiple awaits)
4. ⬜ Update runtime if needed for better value-type support
5. ⬜ Clean up old reference-counted Future code
