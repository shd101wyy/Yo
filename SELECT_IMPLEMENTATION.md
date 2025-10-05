# Go-Style Select Implementation for Yo

## Overview

This document describes the implementation of Go-style `select` statement for Yo's channel-based concurrency model. The implementation follows Go's runtime design closely, using wait queues and proper blocking semantics.

## Problems with Previous Approach

### Try-Loop with Rendezvous (FAILED)
The initial attempt used non-blocking try operations with cooperative yielding:
- **Problem**: Race conditions between sender and receiver
- **Problem**: Both tasks loop rapidly, missing each other in timing
- **Problem**: Rendezvous value gets overwritten/freed in tight loops
- **Problem**: No atomic registration with multiple channels
- **Problem**: Fundamentally incompatible with unbuffered channels

### Blocking on First Case (FAILED)
Attempted to just block on the first case when no default:
- **Problem**: If first case blocks but second case is ready, we wait forever
- **Problem**: Not fair - always prefers first case
- **Problem**: Not how Go works

## Go's Select Algorithm

Go's runtime implements select using a two-phase algorithm:

### Phase 1: Lock and Poll
```
1. Lock ALL channels in consistent order (avoid deadlock)
2. Poll each case to check if ready:
   - Send: receiver waiting OR buffer has space
   - Recv: sender waiting OR buffer has data
3. If any case ready:
   - Perform the operation
   - Unlock all channels
   - Execute case body
   - DONE
4. If default case exists and nothing ready:
   - Unlock all channels
   - Execute default
   - DONE
```

### Phase 2: Register and Park (no default)
```
5. If no cases ready and no default:
   - Create select state for this task
   - Register task with ALL channel wait queues
   - Unlock all channels
   - Park the goroutine (remove from scheduler)
6. When ANY channel becomes ready:
   - Channel wakes the task
   - Task dequeues itself from ALL channels
   - Perform the ready operation
   - Execute case body
```

## Data Structures

### Channel Wait Queues
Each channel has two wait queues:
```c
typedef struct {
  yo_task_queue_t send_queue;  // Tasks waiting to send
  yo_task_queue_t recv_queue;  // Tasks waiting to receive
} channel_wait_queues;
```

Wait queues are **intrusive** - tasks link via `next_wait` pointer.

### Select State
When a task blocks in select, it carries select state:
```c
typedef struct yo_select_case {
  void* channel;              // Which channel
  bool is_send;               // Send or receive?
  void* value_ptr;            // Send: value to send, Recv: where to store
  int case_index;             // Case number for switch statement
} yo_select_case_t;

typedef struct {
  yo_select_case_t* cases;    // Array of cases
  int num_cases;              // How many cases
  int ready_case;             // Which case became ready (-1 if none)
  bool has_default;           // Has default case?
} yo_select_state_t;
```

### Task Structure Updates
```c
struct yo_task {
  // ... existing fields ...
  yo_select_state_t* select_state;  // Non-NULL when blocked in select
  yo_task_t* next_wait;             // For channel wait queues
};
```

## Channel Operations

### Blocking Send (Unbuffered)
```
1. Lock channel
2. Check if receiver in recv_queue:
   YES:
     - Dequeue receiver
     - Copy value directly to receiver's buffer
     - Mark receiver as ready (set ready_case if in select)
     - Unlock channel
     - Wake receiver task
     - DONE
   NO:
     - Add self to send_queue
     - Unlock channel
     - Park task
     - (When woken): value was consumed
     - DONE
```

### Blocking Receive (Unbuffered)
```
1. Lock channel
2. Check if sender in send_queue:
   YES:
     - Dequeue sender
     - Copy value from sender
     - Mark sender as ready
     - Unlock channel
     - Wake sender task
     - Return value
     - DONE
   NO:
     - Add self to recv_queue
     - Unlock channel
     - Park task
     - (When woken): value is available
     - Return value
     - DONE
```

### Buffered Channels
Similar but check buffer space/data before checking wait queues.

## Select Implementation

### Code Generation
The select expression generates C code like this:

```c
{
  // Declare receive variables
  int32_t recv_var_0;
  int32_t recv_var_1;
  
  // Build select cases array
  yo_select_case_t cases[2];
  cases[0] = (yo_select_case_t){ch1, true, &send_value, 0};   // Send case
  cases[1] = (yo_select_case_t){ch2, false, &recv_var_1, 1};  // Recv case
  
  // Call select runtime function
  int ready = __yo_select(cases, 2, has_default);
  
  // Execute ready case
  switch(ready) {
    case 0: { /* send case body */ } break;
    case 1: { /* recv case body */ } break;
    case -1: { /* default case */ } break;
  }
}
```

### Runtime Select Function
```c
int __yo_select(yo_select_case_t* cases, int num_cases, bool has_default) {
  // PHASE 1: Lock all channels in consistent order
  lock_all_channels(cases, num_cases);
  
  // Poll for ready cases
  int ready = poll_cases(cases, num_cases);
  
  if (ready >= 0) {
    // Case is ready - perform operation
    perform_operation(cases[ready]);
    unlock_all_channels(cases, num_cases);
    return ready;
  }
  
  if (has_default) {
    unlock_all_channels(cases, num_cases);
    return -1;  // Execute default
  }
  
  // PHASE 2: No ready cases, no default - must park
  
  // Allocate select state
  yo_select_state_t* state = allocate_select_state(cases, num_cases);
  yo_task_current->select_state = state;
  
  // Register with all channel wait queues
  for (int i = 0; i < num_cases; i++) {
    if (cases[i].is_send) {
      add_to_send_queue(cases[i].channel, yo_task_current);
    } else {
      add_to_recv_queue(cases[i].channel, yo_task_current);
    }
  }
  
  unlock_all_channels(cases, num_cases);
  
  // Park the task (save context and switch)
  park_task();
  
  // ===== RESUMED HERE WHEN WOKEN =====
  
  // One of the channels woke us - which one?
  ready = state->ready_case;
  
  // Dequeue from all channels (we're only on one, but need to check all)
  lock_all_channels(cases, num_cases);
  for (int i = 0; i < num_cases; i++) {
    if (cases[i].is_send) {
      remove_from_send_queue(cases[i].channel, yo_task_current);
    } else {
      remove_from_recv_queue(cases[i].channel, yo_task_current);
    }
  }
  
  // Perform the operation for the ready case
  perform_operation(cases[ready]);
  
  unlock_all_channels(cases, num_cases);
  
  // Free select state
  free_select_state(state);
  yo_task_current->select_state = NULL;
  
  return ready;
}
```

## Waking Tasks in Select

When a channel operation (send/recv) completes, it checks if the peer is in a select:

```c
void wake_receiver(task) {
  if (task->select_state != NULL) {
    // Task is in select - mark which case is ready
    // (The case that uses THIS channel)
    for (int i = 0; i < task->select_state->num_cases; i++) {
      if (task->select_state->cases[i].channel == this_channel &&
          task->select_state->cases[i].is_send == false) {  // recv case
        task->select_state->ready_case = i;
        break;
      }
    }
  }
  // Move task to ready queue
  enqueue_ready(task);
}
```

## Fairness and Ordering

### Channel Locking Order
To avoid deadlocks, we must lock channels in consistent order:
- Sort channels by pointer address before locking
- Always lock in ascending address order

### Case Selection
When multiple cases are ready:
- Go randomizes which case executes (fairness)
- We can start simple: just execute first ready case
- Later optimization: pseudo-random permutation

## Memory Management

### Select State Allocation
- Allocated on stack when possible (fixed case count)
- Heap allocated for variable cases (rare)
- Freed immediately after select completes

### Value Passing
For unbuffered channels:
- **Direct copy**: Sender copies directly to receiver's buffer
- No intermediate storage needed
- Rendezvous is just waking mechanism

## Buffered Channel Considerations

Buffered channels are simpler:
1. Lock channel
2. If buffer has space (send) or data (recv): perform immediately
3. Otherwise: add to wait queue and park

## Integration with Existing Runtime

### Park Operation
```c
void park_task(void) {
  // Save current context
  if (setjmp(yo_task_current->context) == 0) {
    // Saved - now switch to next task
    yo_task_current->state = YO_TASK_BLOCKED;
    schedule_next_task();  // longjmp to next task
  }
  // Resumed here when woken
}
```

### Wake Operation
```c
void wake_task(task) {
  task->state = YO_TASK_READY;
  enqueue_to_ready_queue(task);
}
```

## Testing Strategy

### Phase 1: Basic Select
```yo
// Two receive cases
select(
  (x := <-(ch1)) => { printf("ch1: %d\n", x); },
  (y := <-(ch2)) => { printf("ch2: %d\n", y); }
)
```

### Phase 2: Send and Receive
```yo
// Mixed cases
select(
  (ch1 <- value) => { printf("sent\n"); },
  (x := <-(ch2)) => { printf("recv: %d\n", x); }
)
```

### Phase 3: With Default
```yo
// Non-blocking
select(
  (x := <-(ch)) => { printf("recv: %d\n", x); },
  _ => { printf("nothing ready\n"); }
)
```

### Phase 4: Complex (Fibonacci)
The current `fixme.yo` test with fibonacci and quit channel.

## Implementation Plan

1. **Update channel structure** - Add send_queue and recv_queue ✓ (DONE)
2. **Add select state structures** ✓ (DONE)
3. **Update task structure** ✓ (DONE)
4. **Implement wait queue operations** ✓ (DONE)
5. **Rewrite channel send/recv** to use wait queues
6. **Implement select runtime function** (`__yo_select`)
7. **Update select codegen** to call `__yo_select`
8. **Remove old try_send/try_recv** code
9. **Test with fixme.yo**
10. **Add more tests**

## Breaking Changes

This implementation makes breaking changes:
- Channel internal structure completely changed
- No more `waiting_receivers` counters
- No more `rendezvous_value` pointer
- Different blocking semantics
- Select now properly supports all cases atomically

These are acceptable per project guidelines.

## Performance Considerations

### Optimization Opportunities
1. **Stack allocation**: Allocate select state on stack for known case count
2. **Lock elision**: Skip locking for single-case select
3. **Fast path**: Inline poll for common patterns
4. **Buffered fast path**: Check buffer before locking for buffered channels

### Scalability
- Per-channel wait queues scale well (no global queues)
- Lock contention only during channel operations
- Task parking is cheap (just setjmp/longjmp)

## Comparison with Go

### Similar to Go
- Two-phase select algorithm
- Wait queue registration
- Direct value passing for unbuffered channels
- Task parking semantics

### Different from Go
- Simpler: No channel lock-free fast paths (yet)
- Simpler: No randomization of ready cases (yet)
- Simpler: No work stealing (tasks stay on worker)
- Same thread affinity model (for BRC compatibility)

## References

- Go runtime source: `runtime/select.go`
- Go runtime source: `runtime/chan.go`
- Paper: "The Design and Implementation of a Scalable Scheduler for Go"
