# Go-Style Select Implementation for Yo

## Overview

This document describes the implementation of Go-style `select` statement for Yo's channel-based concurrency model. The implementation follows Go's runtime design closely, using wait queues and proper blocking semantics.

**Status**: Core implementation complete. Simple cases work reliably. Unbuffered select rendezvous semantics need refinement for complex multi-iteration scenarios.

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

### ✅ Phase 1: Basic Send/Receive (COMPLETE)
```yo
// test_simple_recv.yo - Simple sender/receiver
main :: (fn() -> unit) {
  ch := chan(i32);
  
  async {
    ch <- 42;
  };
  
  result := <-(ch);
  value := result.unwrap();
  printf("value=%d\n", value);  // Prints: value=42
};
```
**Status**: ✅ Works perfectly - 20/20 test runs successful

### ⚠️ Phase 2: Select with Mixed Cases (PARTIAL)
```yo
// fixme.yo - Fibonacci with select
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
      (q := <-(quit)) => {
        printf("quit %d\n", q);
        return;
      }
    ));
};
```
**Status**: ⚠️ First iteration works (prints 0, 1), then deadlocks
**Issue**: Unbuffered select rendezvous semantics (see Known Issues)

### ❌ Phase 3: With Default (TODO)
```yo
// Non-blocking select
select(
  (x := <-(ch)) => { printf("recv: %d\n", x); },
  _ => { printf("nothing ready\n"); }
)
```
**Status**: ❌ Not yet tested

### ❌ Phase 4: Buffered Channels (TODO)
Test select with buffered channels to verify buffer handling.

## Implementation Plan

1. **Update channel structure** - Add send_queue and recv_queue ✅ (DONE)
2. **Add select state structures** ✅ (DONE)
3. **Update task structure** ✅ (DONE)
4. **Implement wait queue operations** ✅ (DONE)
5. **Rewrite channel send/recv** to use wait queues ✅ (DONE)
6. **Implement select runtime function** (`__yo_select`) ✅ (DONE)
7. **Update select codegen** to call `__yo_select` ✅ (DONE)
8. **Remove old try_send/try_recv** code ✅ (DONE)
9. **Fix task context switching bugs** ✅ (DONE - fixed double setjmp, uninitialized fields, blocked queue routing)
10. **Fix main-as-task** ✅ (DONE - spawn main as task to avoid pthread/task communication deadlock)
11. **Fix atomic task counter** ✅ (DONE - use atomic counter instead of queue polling to avoid race conditions)
12. **Fix select sender value extraction** ✅ (DONE - extract values from select_state when sender is in select)
13. **Test with simple cases** ✅ (DONE - test_simple_recv.yo works 100% reliably)
14. **Fix unbuffered select rendezvous** ⚠️ (IN PROGRESS - see Known Issues below)
15. **Test with fixme.yo** ⚠️ (PARTIAL - first iteration works, subsequent iterations deadlock)
16. **Add more tests** ❌ (TODO)

## Implementation Status

### ✅ Completed Features

#### Core Select Implementation
- ✅ Two-phase select algorithm (lock-poll-park / register-wait-wake)
- ✅ Wait queue operations (add/remove/pop/empty)
- ✅ Select state management (allocation, initialization, cleanup)
- ✅ Channel send with wait queues (parks sender if no receiver)
- ✅ Channel receive with wait queues (parks receiver if no sender)
- ✅ Select runtime function with Go's algorithm
- ✅ Select expression codegen (builds case array, calls __yo_select)
- ✅ Phase 1: Lock all channels and poll for ready cases
- ✅ Phase 2: Register with wait queues and park if no ready cases
- ✅ Wake and resume logic when channel becomes ready
- ✅ Dequeue from all wait queues after waking

#### Critical Bug Fixes
- ✅ **Double setjmp bug** - __yo_task_yield was doing setjmp when caller already did it
- ✅ **Uninitialized fields** - select_state and next_wait had garbage values
- ✅ **Blocked queue routing** - Tasks were going to ready queue even when state was BLOCKED
- ✅ **Main thread deadlock** - Main ran on main thread (pthread), tasks ran on workers (task queues) - couldn't communicate
  - Solution: Spawn main as a task using `__yo_task_spawn_unit_function`
- ✅ **Task wait race condition** - `__yo_task_wait_all()` checked queues before tasks were enqueued
  - Solution: Use atomic counter `yo_active_task_count` incremented on spawn, decremented on completion
- ✅ **Select sender value extraction** - Regular receive didn't know how to extract value from select sender
  - Solution: Check if sender->select_state is not NULL, then find the send case and extract value from cases[i].value_ptr

#### Working Test Cases
- ✅ **test_simple_recv.yo** - Sender task sends to receiver task via unbuffered channel
  - Tested 20 times: 100% success rate
  - Demonstrates: task spawning, channel send/recv, wait queues, task parking/resuming
  
### ⚠️ Known Issues

#### Unbuffered Select Rendezvous Semantics
**Status**: Partial implementation - works for first send, fails on subsequent iterations

**Problem**: When select performs an unbuffered send to a parked receiver:
1. Select Phase 1 finds receiver in recv_queue
2. Select writes value to buffer, wakes receiver, returns immediately
3. Sender continues execution (e.g., loops back to select)
4. Sender tries to send again BEFORE receiver has finished processing first value
5. Receiver is still executing (not yet parked for second receive)
6. Sender's select sees no receiver in recv_queue, parks in Phase 2
7. Receiver finishes processing, tries to receive again, parks
8. **Both tasks parked → deadlock**

**Root Cause**: Select treats unbuffered send as async (write-and-continue) instead of sync (write-and-wait). Go's select waits for true rendezvous - sender doesn't continue until receiver has received.

**Example Failure**: fixme.yo fibonacci
- First iteration: ✅ Fibonacci sends 0, consumer receives and prints it
- Second iteration: ❌ Fibonacci parks trying to send 1, consumer parks trying to receive
- Result: Deadlock after printing "0\n1\n"

**Attempted Solutions**:
1. ❌ Buffered channels - Didn't help, issue is in select coordination
2. ⚠️ Check buffer in regular receive - Receiver finds value in buffer, but sender already parked

**Correct Solution** (not yet implemented):
When select performs unbuffered send:
1. Find receiver in recv_queue
2. Write value to receiver's buffer (or select state)
3. Wake receiver
4. **Sender must wait/park until receiver confirms receipt**
5. Only then return from select

This requires:
- Sender parks after writing value
- Receiver wakes sender after taking value
- Bidirectional handshake for rendezvous

Alternatively, for unbuffered channels in select:
- Don't use buffer as intermediary
- Pass value pointer directly
- Use synchronization to ensure atomic exchange

### 🎯 What Works Perfectly

1. **Simple send/receive** (test_simple_recv.yo)
   - Single sender → single receiver
   - Unbuffered channel
   - Task spawning and coordination
   - Wait queues and parking
   - 100% reliable

2. **Select with receiver already waiting**
   - If receiver parks first, sender's select finds it immediately
   - Handoff works correctly
   - No race conditions

3. **Task scheduling infrastructure**
   - Cooperative scheduling with setjmp/longjmp
   - Worker thread pools
   - Per-worker ready/blocked queues
   - Task parking and waking
   - Atomic task counter for wait_all

4. **Select Phase 1 (Poll)**
   - Correctly locks all channels
   - Polls for ready cases
   - Performs operations when ready
   - Returns correct case index

5. **Select Phase 2 (Park)**
   - Registers with wait queues correctly
   - Parks task properly
   - Wakes on channel ready
   - Dequeues from all queues

### 📋 Remaining Work

1. **Fix unbuffered select rendezvous** (PRIORITY)
   - Implement bidirectional handshake
   - Ensure sender waits for receiver confirmation
   - Test with fibonacci example
   
2. **Struct return corruption** (LOWER PRIORITY)
   - Channel receive expressions use output parameter ✅
   - Specialized wrapper functions still use struct returns ❌
   - Need to propagate output-parameter pattern throughout

3. **Additional test cases**
   - Multiple senders, one receiver
   - One sender, multiple receivers  
   - Buffered channel select
   - Select with default (non-blocking)
   - Select with timeout (using timer channel)

4. **Optimizations** (FUTURE)
   - Stack-allocate select state for fixed case count
   - Randomize ready case selection (fairness)
   - Lock elision for single-case select
   - Fast path for buffered channels

## Breaking Changes

This implementation makes breaking changes:
- Channel internal structure completely changed
- No more `waiting_receivers` counters
- No more `rendezvous_value` pointer
- Different blocking semantics
- Select now properly supports all cases atomically
- Main function now runs as a task (not on main thread)
- Task completion uses atomic counter (not queue polling)

These are acceptable per project guidelines.

## Recent Improvements

### Main-as-Task (Commit: 2024-10-06)
**Problem**: Main thread used pthread blocking (pthread_cond_wait), while async tasks used task wait queues. They couldn't communicate across this boundary.

**Solution**: Spawn main function as a task on worker thread:
```c
int main(void) {
  __yo_task_spawn_unit_function(yo_user_main);
  __yo_task_wait_all();
  return 0;
}
```

Now all channel operations use task wait queues uniformly.

### Atomic Task Counter (Commit: 2024-10-06)
**Problem**: `__yo_task_wait_all()` polled worker queues to check if all tasks completed. Race condition: tasks could be spawned after the check but before shutdown.

**Solution**: Use atomic counter:
```c
static _Atomic size_t yo_active_task_count = 0;

// On spawn:
atomic_fetch_add(&yo_active_task_count, 1);

// On completion:
atomic_fetch_sub(&yo_active_task_count, 1);

// In wait_all:
while (atomic_load(&yo_active_task_count) > 0) {
  usleep(1000);
}
```

This eliminates the race - counter is incremented BEFORE enqueueing, ensuring wait_all sees all spawned tasks.

### Select Sender Value Extraction (Commit: 2024-10-06)
**Problem**: When regular receive found a sender in send_queue, it assumed value was in buffer. But if sender was in select, value was in sender's select_state.

**Solution**: Check if sender is in select:
```c
if (sender->select_state) {
  // Find the send case for this channel
  for (int i = 0; i < sender->select_state->num_cases; i++) {
    if (sender->select_state->cases[i].channel == chan && 
        sender->select_state->cases[i].is_send) {
      // Extract value from select state
      result->tag = SOME;
      result->data.Some.value = *(T*)sender->select_state->cases[i].value_ptr;
      sender->select_state->ready_case = i;
      break;
    }
  }
} else {
  // Regular send - value in buffer
  result->data.Some.value = chan->buffer[0];
  chan->size = 0;
}
```

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
- Atomic case selection

### Different from Go
- Simpler: No channel lock-free fast paths (yet)
- Simpler: No randomization of ready cases (yet)
- Simpler: No work stealing (tasks stay on worker)
- Same thread affinity model (for BRC compatibility)
- **Different**: Unbuffered select rendezvous not fully implemented (in progress)
  - Go: Sender waits for receiver to complete receive
  - Yo (current): Sender writes value and continues immediately
  - Yo (planned): Implement bidirectional handshake for rendezvous

### Architecture Decisions

1. **Main as Task**: Unlike Go where main is special, Yo spawns main as a regular task
   - Benefit: Uniform channel operations across all execution contexts
   - Benefit: No special-casing for main thread
   
2. **Atomic Task Counter**: Track active tasks with atomic counter
   - Benefit: No race conditions in task completion detection
   - Benefit: Clean shutdown without queue polling
   
3. **Intrusive Wait Queues**: Tasks link via `next_wait` pointer
   - Benefit: No separate queue nodes to allocate
   - Benefit: O(1) enqueue/dequeue operations
   
4. **Select State in Task**: Task carries select_state when blocked in select
   - Benefit: Channel can identify if peer is in select
   - Benefit: Enables proper value extraction and case marking

## Debug and Troubleshooting

### Debug Flags
Enable debug output with compiler flags:
- `--debug-concurrency`: Task scheduling, spawning, parking, waking
- `--debug-brc`: Biased reference counting operations

### Common Issues

1. **Tasks not waking**: Check if wait_channel matches the waking channel
2. **Deadlock**: Both tasks blocked - verify wait queues and wakeup calls
3. **Race conditions**: Use debug output to trace execution order
4. **Struct corruption**: longjmp across stacks corrupts struct returns - use output parameters

### Debugging Workflow
```bash
# Compile with debug
bun run src/yo-cli.ts test.yo --debug-concurrency -o test

# Run and analyze
./test 2>&1 | grep -E "(SPAWN|TASK|WAKEUP|CHAN)"

# Look for:
# - Task spawn and assignment to workers
# - Task execution and parking
# - Channel operations and buffer state
# - Wakeup calls and task state transitions
```

## References

- Go runtime source: `runtime/select.go`
- Go runtime source: `runtime/chan.go`
- Paper: "The Design and Implementation of a Scalable Scheduler for Go"
