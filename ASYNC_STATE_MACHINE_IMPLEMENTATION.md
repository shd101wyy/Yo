# Async/Await State Machine Implementation

## Overview

This document describes the implementation of async/await using state machine transformation for the Yo language.

## Approach

We transform each async function containing `await` expressions into a state machine.

### Example Transformation

**Input Yo code:**
```yo
task1 :: (async(fn() -> Future(i32))) {
  printf("running task1\n");
  return 1;
};

main :: (async(fn() -> Future(unit))) {
  printf("Hello, async world!\n");
  t1 := task1();
  await t1;
  printf("Done running task1");
};
```

**Generated C code (conceptual):**

```c
// State machine struct for main function
typedef struct {
  int state;                    // Current state (0, 1, 2, ...)
  yo_future_void_t* result;     // The Future this async function returns
  
  // Local variables
  yo_future_int32_t_t* t1;      // Captured locals
  
  // Temporary values for await results
  int32_t await_result_1;
} yo_main_state_machine_t;

// Resume function - called to advance the state machine
void yo_main_resume(yo_main_state_machine_t* sm) {
  switch (sm->state) {
    case 0: // Initial state
      printf("Hello, async world!\n");
      sm->t1 = yof4ca7ba3_task1();  // Call async function
      sm->state = 1;                 // Next state
      // Schedule task1 to run
      yo_async_spawn(sm->t1);
      // Check if t1 is ready
      if (sm->t1->state == YO_FUTURE_COMPLETED) {
        goto state_1;  // Continue immediately
      } else {
        // Register continuation and yield
        yo_async_await_future(sm->t1, yo_main_resume, sm);
        return;
      }
      
    state_1:
    case 1: // After await t1
      sm->await_result_1 = sm->t1->result;  // Extract result (i32)
      printf("Done running task1");
      
      // Complete the Future
      sm->result->state = YO_FUTURE_COMPLETED;
      sm->result->is_running = false;
      sm->state = 2;  // Terminal state
      
      // Free state machine
      __yo_free(sm);
      return;
  }
}

// Main async function entry point
yo_future_void_t* yo_user_main() {
  // Allocate state machine
  yo_main_state_machine_t* sm = __yo_malloc(sizeof(yo_main_state_machine_t));
  sm->state = 0;
  
  // Allocate Future result
  yo_future_void_t* future = __yo_malloc(sizeof(yo_future_void_t));
  future->header.ref_count = 1;
  future->header.owner_thread_id = __yo_get_thread_id();
  future->state = YO_FUTURE_PENDING;
  future->is_running = true;
  sm->result = future;
  
  // Start the state machine
  yo_main_resume(sm);
  
  return future;
}
```

## Implementation Steps

### 1. Await Point Analysis
- Walk the AST of async function bodies
- Identify all `await` expressions
- Number them sequentially (0, 1, 2, ...)
- Identify all local variables that need to be captured

### 2. State Machine Struct Generation
For each async function with await:
```c
typedef struct {
  int state;              // Current state ID
  FutureType* result;     // The Future returned by this async function
  LocalType1 local1;      // All local variables
  LocalType2 local2;
  // ...
  ResultType1 await_result_1;  // Results from await expressions
  ResultType2 await_result_2;
  // ...
} FunctionNameStateMachine;
```

### 3. State Generation
Split the function body at each await:
- **State 0**: From start to first await
- **State 1**: From first await to second await
- **State N**: From last await to return

Each state:
1. Executes code until next await/return
2. Updates state machine's `state` field
3. If await: check if Future is ready
   - Ready: continue immediately (goto next state)
   - Not ready: register continuation, yield (return)
4. If return: mark result Future as completed, free state machine

### 4. Resume Function
```c
void FunctionName_resume(FunctionNameStateMachine* sm) {
  switch (sm->state) {
    case 0: /* state 0 code */ break;
    case 1: /* state 1 code */ break;
    // ...
  }
}
```

### 5. Async Function Entry Point
```c
FutureType* FunctionName(Args...) {
  // Allocate state machine
  FunctionNameStateMachine* sm = malloc(...);
  sm->state = 0;
  
  // Copy arguments to state machine
  sm->arg1 = arg1;
  // ...
  
  // Allocate result Future
  FutureType* future = malloc(...);
  future->state = YO_FUTURE_PENDING;
  future->is_running = true;
  sm->result = future;
  
  // Start execution
  FunctionName_resume(sm);
  
  return future;
}
```

### 6. Await Operator Implementation
```c
// At await point:
if (future_to_await->state == YO_FUTURE_COMPLETED) {
  // Ready - extract result and continue
  result = future_to_await->result;
  // goto next state
} else {
  // Not ready - register continuation
  yo_async_register_continuation(
    future_to_await,
    FunctionName_resume,
    sm
  );
  return;  // Yield control
}
```

### 7. Async Runtime
Need to implement:
- **Task queue**: FIFO queue of pending tasks
- **Event loop**: Polls Futures, runs ready tasks
- **Continuation system**: When Future completes, resume waiting tasks
- **Spawn function**: Add new async task to queue

```c
// Global async runtime
typedef struct {
  TaskQueue ready_queue;        // Tasks ready to run
  TaskQueue waiting_queue;      // Tasks waiting on Futures
} AsyncRuntime;

void yo_async_spawn(Future* future);
void yo_async_register_continuation(Future* future, ResumeFn fn, void* sm);
void yo_async_run_until_complete();  // Event loop
```

## Design Decisions

1. **Eager vs Lazy**: Async functions start executing immediately when called (eager)
2. **Synchronous local execution**: Within a state, execution is synchronous until await
3. **Cooperative scheduling**: Tasks yield at await points
4. **No preemption**: Only context switches at explicit await points
5. **Simple runtime**: Single-threaded event loop for MVP

## Future Enhancements

1. **Multi-threaded executor**: Work-stealing task scheduler
2. **async blocks**: `async { expr }` creates anonymous async tasks
3. **Select/race**: Wait on multiple Futures
4. **Timeouts**: `await_timeout(future, duration)`
5. **Cancellation**: Cancel running async tasks

## Related Documents

- See `ASYNC_AWAIT.md` for high-level design
- See `BIASED_REFERENCE_COUNTING.md` for Future memory management
