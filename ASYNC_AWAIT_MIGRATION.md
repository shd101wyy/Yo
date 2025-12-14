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

### 4. Runtime Changes

The async runtime needs to:
1. Accept pointers to stack-allocated state machines
2. Not reference count the futures themselves
3. Still manage task queuing and resumption

## Migration Steps

### Phase 1: Type System Updates ✅ (Completed)

1. ✅ Update `getTypeString()` to handle `Impl(Future(T))` as value types
2. ✅ Update `collectType()` to collect `FutureModuleType`
3. ✅ Add `typeImplementsFuture` and `extractFutureModuleFromType` imports

### Phase 2: State Machine Struct Generation ✅ (Completed)

1. ✅ Remove `yo_ref_header_t` from state machine struct
2. ✅ Add `result` field directly to struct (not pointer to Future)
3. ✅ Use `typedef struct X_struct { ... } X;` pattern
4. ✅ Register struct name in context.types under FutureModuleType's ID

### Phase 3: Constructor Generation (In Progress)

1. ✅ Return struct by value instead of pointer
2. ⬜ Don't spawn task immediately - lazy evaluation
3. ⬜ Initialize state to 0 (not started)
4. ⬜ Copy captured variables into struct

### Phase 4: Resume Function Updates (TODO)

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

1. ⬜ Update `yo_async_spawn_task` to work with value types
2. ⬜ Update `yo_await_*` functions for value semantics
3. ⬜ Remove reference counting from async runtime
4. ⬜ Update task queue to track pointers to stack values

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

### Eager vs Lazy Spawning

ASYNC_AWAIT.md mentions JavaScript-style eager spawning, but with value types we need to be careful:

```yo
task1 := async { ... };  // Creates state machine, optionally starts execution
// task1 is on stack
x := await task1;        // Polls/resumes until complete
```

Options:
1. **Lazy**: Constructor just initializes state, first await starts execution
2. **Eager**: Constructor spawns task, await waits for completion

For simplicity, we'll start with **lazy** evaluation.

### Memory Lifetime

With value types, the Future lives on the stack of its parent function:

```c
void parent() {
  task1_state_t task1 = __yo_new_task1(capture);
  // task1 is on parent's stack
  
  i32 x = yo_await(&task1);
  // task1 must remain valid until await completes
  
  // task1 goes out of scope here - automatically cleaned up
}
```

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

## Current Progress

Files modified:
- `src/codegen/utils/index.ts` - getTypeString for Impl(Future(T))
- `src/codegen/types/collection.ts` - collectType for Future
- `src/codegen/expressions/generation.ts` - async block struct generation
- `src/codegen/functions/context.ts` - deferredAsyncBlocks interface

Next immediate steps:
1. Fix Type import in context.ts
2. Complete constructor generation (lazy)
3. Update resume function for value semantics
4. Implement await for value types
5. Generate drop functions
