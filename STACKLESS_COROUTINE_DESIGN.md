# Stackless Coroutine Design for Yo Language

## Overview

This document describes a **stackless coroutine implementation** using continuation-passing style (CPS) transformation. This approach:
- ✅ Works with WASM (no assembly, no stack switching)
- ✅ Simpler implementation (no setjmp/longjmp)
- ✅ Better debugging (normal C call stack)
- ✅ Cross-platform (pure C, no architecture-specific code)
- ✅ Memory efficient (no 64KB per-task stack allocation)

## Key Idea

Instead of using separate stacks and context switching, we **transform async functions into state machines** that can be suspended and resumed. Each suspension point becomes a state, and resuming just means calling the continuation function with the saved state.

## Core Concepts

### 1. Task Structure (Simplified)

```c
typedef enum {
  YO_TASK_READY,      // Ready to run
  YO_TASK_RUNNING,    // Currently running
  YO_TASK_SUSPENDED,  // Suspended (waiting on channel)
  YO_TASK_COMPLETED   // Finished
} yo_task_state_t;

typedef struct yo_task {
  void (*continuation)(struct yo_task*);  // Function to resume from current state
  void* data;                              // Task-local state (struct containing local vars)
  int state_id;                            // Which suspension point we're at
  yo_task_state_t status;                  // Current task status
  void* wait_channel;                      // Channel we're waiting on (NULL if not waiting)
  struct yo_task* next;                    // Next in queue
} yo_task_t;
```

**Key differences from stackful**:
- No `jmp_buf context` - we don't save CPU registers
- No `char* stack` - we don't allocate separate stacks
- `continuation` function pointer - where to resume
- `state_id` - which suspension point (state machine state)
- `data` - heap-allocated struct containing all local variables

### 2. State Machine Transformation

When you write:

```yo
fibonacci :: (fn(ch : Chan(i32), quit : Chan(i32)) -> unit) {
  x := 0;
  y := 1;

  while(true,
    select(
      (ch <- x) => {
        temp := x;
        x = y;
        y = (temp + y);
      },
      (q := <-quit) => {
        printf("quit %d\n", q);
        return;
      }
    ));
};
```

We transform it to:

```c
// State IDs
enum {
  STATE_ENTRY = 0,
  STATE_AFTER_SELECT = 1,
  STATE_COMPLETED = 2
};

// Task data structure (holds all local variables)
typedef struct {
  yo_chan_int32_t_t* ch;     // Parameters
  yo_chan_int32_t_t* quit;
  int32_t x;                  // Local variables
  int32_t y;
  int32_t temp;
  yo_enum_ltp3vb8b9z q;
  int select_result;          // Saved select result
} fibonacci_task_data_t;

// Continuation function
void fibonacci_continuation(yo_task_t* task) {
  fibonacci_task_data_t* data = (fibonacci_task_data_t*)task->data;
  
  switch (task->state_id) {
    case STATE_ENTRY:
      // Initialize locals
      data->x = 0;
      data->y = 1;
      goto state_entry;
      
    case STATE_AFTER_SELECT:
      // Resume after select
      goto state_after_select;
      
    default:
      return; // Completed
  }

state_entry:
  while (true) {
    // Try select (non-blocking poll)
    yo_select_case_t cases[2];
    int32_t send_val = data->x;
    cases[0] = (yo_select_case_t){data->ch, true, &send_val, 0};
    cases[1] = (yo_select_case_t){data->quit, false, &data->q, 1};
    
    int result = __yo_select_poll(cases, 2);
    
    if (result >= 0) {
      // A case is ready - handle it
      data->select_result = result;
      goto handle_select_result;
    } else {
      // No case ready - suspend
      task->state_id = STATE_AFTER_SELECT;
      __yo_select_register_and_suspend(task, cases, 2);
      return; // Return to scheduler
    }

state_after_select:
    // Resumed! The waker has set task->select_result
    
handle_select_result:
    switch (data->select_result) {
      case 0: // ch <- x
        data->temp = data->x;
        data->x = data->y;
        data->y = (data->temp + data->y);
        break;
        
      case 1: // q := <-quit
        printf("quit %d\n", data->q);
        task->state_id = STATE_COMPLETED;
        task->status = YO_TASK_COMPLETED;
        return;
    }
  }
}

// Spawn function
void spawn_fibonacci(yo_chan_int32_t_t* ch, yo_chan_int32_t_t* quit) {
  yo_task_t* task = (yo_task_t*)malloc(sizeof(yo_task_t));
  fibonacci_task_data_t* data = (fibonacci_task_data_t*)malloc(sizeof(fibonacci_task_data_t));
  
  data->ch = ch;
  data->quit = quit;
  
  task->continuation = fibonacci_continuation;
  task->data = data;
  task->state_id = STATE_ENTRY;
  task->status = YO_TASK_READY;
  task->wait_channel = NULL;
  
  __yo_task_enqueue(task);
}
```

### 3. Select Implementation (Non-Blocking)

```c
// Poll select cases (non-blocking)
int __yo_select_poll(yo_select_case_t* cases, int num_cases) {
  // Lock all channels
  for (int i = 0; i < num_cases; i++) {
    pthread_mutex_lock(&cases[i].channel->mutex);
  }
  
  // Try to find a ready case
  for (int i = 0; i < num_cases; i++) {
    if (cases[i].is_send) {
      // Check if receiver waiting or buffer has space
      if (!queue_empty(cases[i].channel->recv_queue) || 
          cases[i].channel->size < cases[i].channel->capacity) {
        // This case is ready!
        __yo_channel_perform_send(cases[i].channel, cases[i].value_ptr);
        // Unlock all
        for (int j = 0; j < num_cases; j++) {
          pthread_mutex_unlock(&cases[j].channel->mutex);
        }
        return i;
      }
    } else {
      // Check if sender waiting or buffer has data
      if (!queue_empty(cases[i].channel->send_queue) || 
          cases[i].channel->size > 0) {
        // This case is ready!
        __yo_channel_perform_recv(cases[i].channel, cases[i].value_ptr);
        // Unlock all
        for (int j = 0; j < num_cases; j++) {
          pthread_mutex_unlock(&cases[j].channel->mutex);
        }
        return i;
      }
    }
  }
  
  // Unlock all
  for (int i = 0; i < num_cases; i++) {
    pthread_mutex_unlock(&cases[i].channel->mutex);
  }
  
  return -1; // No ready case
}

// Register task with channels and suspend
void __yo_select_register_and_suspend(yo_task_t* task, yo_select_case_t* cases, int num_cases) {
  // Lock all channels
  for (int i = 0; i < num_cases; i++) {
    pthread_mutex_lock(&cases[i].channel->mutex);
  }
  
  // Register task with all channels
  for (int i = 0; i < num_cases; i++) {
    if (cases[i].is_send) {
      queue_push(&cases[i].channel->send_queue, task);
    } else {
      queue_push(&cases[i].channel->recv_queue, task);
    }
  }
  
  task->status = YO_TASK_SUSPENDED;
  
  // Unlock all channels
  for (int i = 0; i < num_cases; i++) {
    pthread_mutex_unlock(&cases[i].channel->mutex);
  }
  
  // Task is now suspended - scheduler will move it to blocked queue
}
```

### 4. Channel Wake-Up

```c
void __yo_channel_wakeup_one_task(yo_chan_t* chan) {
  // Called when a channel operation completes
  // Wake one task from send_queue or recv_queue
  
  yo_task_t* task = queue_pop(&chan->send_queue);
  if (!task) {
    task = queue_pop(&chan->recv_queue);
  }
  
  if (task) {
    task->status = YO_TASK_READY;
    task->wait_channel = NULL;
    __yo_task_enqueue(task); // Move to ready queue
  }
}
```

### 5. Scheduler (Simple Run Loop)

```c
void __yo_task_run_scheduler(void) {
  while (true) {
    yo_task_t* task = __yo_task_dequeue();
    
    if (!task) {
      // No ready tasks
      if (has_suspended_tasks()) {
        // Deadlock - all tasks suspended
        fprintf(stderr, "Deadlock: all tasks suspended\n");
        break;
      }
      break; // All tasks completed
    }
    
    task->status = YO_TASK_RUNNING;
    
    // Call continuation - it will return when:
    // 1. Task suspends (returns early)
    // 2. Task completes (returns at end)
    task->continuation(task);
    
    if (task->status == YO_TASK_COMPLETED) {
      // Free task data
      free(task->data);
      free(task);
    } else if (task->status == YO_TASK_SUSPENDED) {
      // Task suspended - don't re-enqueue (it's in channel wait queues)
    } else {
      // Task yielded but still ready - re-enqueue
      __yo_task_enqueue(task);
    }
  }
}
```

## Code Generation Strategy

### For Regular Functions

No change - generate normal C functions.

### For Async Functions (spawned with `async { ... }`)

1. **Create task data struct** with:
   - All parameters
   - All local variables
   - Temporaries for suspension points

2. **Create continuation function** with:
   - `switch (state_id)` at the top
   - `goto` labels for each suspension point
   - Return early when suspending

3. **Create spawn function** that:
   - Allocates task and data
   - Initializes data with parameters
   - Sets continuation pointer
   - Enqueues task

### Suspension Points

Identify suspension points (where task might block):
- `<-chan` (channel receive)
- `chan <- value` (channel send)
- `select { ... }` (select statement)

At each suspension point:
1. Try operation (non-blocking)
2. If successful, continue
3. If would block:
   - Save state_id for next resumption point
   - Register with wait queues
   - Return to scheduler

### Example: Channel Send

```c
// Current code (stackful):
__yo_chan_send(chan, value);  // Might block with setjmp/longjmp

// New code (stackless):
if (!__yo_chan_try_send(chan, value)) {
  // Would block - suspend
  task->state_id = STATE_AFTER_SEND_123;
  __yo_chan_register_sender(chan, task, value);
  return; // Return to scheduler
}
state_after_send_123:
// Continue after send completes
```

## Advantages Over Stackful

### 1. **WASM Compatible**
- No assembly code
- No stack manipulation
- Just normal C function calls

### 2. **Simpler**
- No setjmp/longjmp
- No context switching
- No stack allocation/deallocation

### 3. **Debuggable**
- Normal C call stack
- Can inspect task data struct
- No stack corruption bugs

### 4. **Memory Efficient**
- Only allocate what's needed for local vars
- No 64KB per-task overhead
- Can have millions of tasks

### 5. **Cross-Platform**
- Works on any platform with C compiler
- No architecture-specific code
- Same binary works everywhere

## Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Define new `yo_task_t` structure (no stack, no jmp_buf)
- [ ] Implement simple task queue (ready/suspended)
- [ ] Implement basic scheduler loop
- [ ] Remove all setjmp/longjmp/assembly code

### Phase 2: Channel Operations
- [ ] Implement `__yo_chan_try_send` (non-blocking)
- [ ] Implement `__yo_chan_try_recv` (non-blocking)
- [ ] Implement channel wait queues for suspended tasks
- [ ] Implement wake-up mechanism

### Phase 3: Select Transformation
- [ ] Implement `__yo_select_poll` (non-blocking)
- [ ] Implement `__yo_select_register_and_suspend`
- [ ] Transform select in codegen to state machine

### Phase 4: Async Function Transformation
- [ ] Detect async functions in codegen
- [ ] Generate task data struct
- [ ] Generate continuation function with state machine
- [ ] Generate spawn function
- [ ] Handle nested async calls

### Phase 5: Testing & Optimization
- [ ] Test fibonacci example
- [ ] Test complex select patterns
- [ ] Benchmark vs stackful (should be faster!)
- [ ] Add worker thread pool (same as before)

## Comparison Table

| Feature | Stackful (Current) | Stackless (Proposed) |
|---------|-------------------|----------------------|
| WASM Support | ❌ No (assembly) | ✅ Yes |
| Memory per Task | 64KB (stack) | ~100 bytes (data) |
| Context Switch | setjmp/longjmp | Function call |
| Debugging | Hard (stack corruption) | Easy (normal stack) |
| Platform Support | x86_64 only | Any C platform |
| Code Complexity | High | Medium |
| Performance | Good | Better (less overhead) |
| Max Tasks | ~1000 (memory limit) | Millions |

## Related Work

This design is inspired by:

1. **Rust's async/await**: Uses state machines, no stack
2. **JavaScript Promises**: Stackless, continuation-based
3. **C++ Coroutines (C++20)**: Stackless, compiler transforms to state machine
4. **Go's goroutines**: Stackful but uses segmented stacks (complex)
5. **Kotlin coroutines**: Stackless with CPS transformation

## Migration Path

We can migrate incrementally:

1. Keep stackful implementation in a branch
2. Implement stackless in parallel
3. Add feature flag to switch between them
4. Test thoroughly
5. Once stackless is stable, remove stackful
6. Clean up code

## Open Questions

1. **How to handle callbacks/closures in async functions?**
   - Store closure data in task data struct
   - Include closure pointer in continuation

2. **How to handle recursion?**
   - Tail recursion → while loop
   - Non-tail recursion → trampoline or explicit stack in data

3. **How to handle exceptions/panics?**
   - Store error state in task
   - Unwind by setting state to error

4. **Thread pool integration?**
   - Same as before - distribute tasks across workers
   - Each worker runs scheduler loop
   - Lock-free work stealing queue

## Conclusion

Stackless coroutines are the **right choice** for Yo language:
- **Production-ready**: Battle-tested in Rust, JavaScript, C++
- **WASM-friendly**: Critical for modern deployment
- **Simpler**: Easier to implement and maintain
- **Efficient**: Less memory, faster context switch

The transformation is mechanical and can be automated in the codegen phase.
