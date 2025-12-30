# Async Early Return - Missing Local Variable Drops

**Status:** 🔴 OPEN  
**Date:** December 30, 2025  
**Severity:** High (Memory Leak)

## Problem

Async state machines that complete early (via early return in conditional blocks) do not drop their local variables, causing memory leaks.

## Example

```yo
async {
  buffer := ArrayList.with_capacity(size);
  
  if (buffer.ptr() == null) {
    return .Err(...);  // Early return - buffer is NOT dropped!
  }
  
  // ... use buffer
  return .Ok(...);  // Normal return - buffer IS dropped
}
```

## Root Cause

The async state machine codegen generates "drop local variables" code only at the normal completion point (end of function), not at early return points within conditional blocks.

### Generated C Code

**Early return (inside if/else):**
```c
if (_yoa08d9b3a_temp_14350 != NULL) {
  // ... use buffer
} else {
  // Early return - no local variable drops!
  sm->result = error_result;
  atomic_store_explicit(&sm->state, -1, memory_order_release);
  __yo_decr_rc((void*)sm);  // Drop state machine
  return;  // buffer_2 is NEVER dropped!
}
```

**Normal return (end of function):**
```c
// Drop local variables before completion
if (sm->var_yoa08d9b3a_io_future != NULL) { 
  __yo_decr_rc((void*)sm->var_yoa08d9b3a_io_future); 
};
fn_id31561___drop(sm->var_yoa08d9b3a_buffer_2);  // Properly dropped

// Final state - complete the Future
atomic_store_explicit(&sm->state, -1, memory_order_release);
__yo_decr_rc((void*)sm);
return;
```

## Manifestation

Memory leaks detected by AddressSanitizer:
```
Direct leak of 72 byte(s) in 1 object(s) allocated from:
    #1 0x406d8e in _yoa08d9b3a_temp_14402_resume
    
Indirect leak of 46 byte(s) in 1 object(s) allocated from:
    #1 0x406a00 in fn_id30772_with_capacity
    #2 0x406cc5 in _yoa08d9b3a_temp_14402_resume
```

These are the ArrayList and its buffer allocated but never freed when the async function returns early.

## Solution

### Option 1: Drop locals before ALL completion points

Generate local variable drop code before EVERY early return, not just at the function end.

```c
if (_yoa08d9b3a_temp_14350 != NULL) {
  // ... use buffer
} else {
  // Drop local variables before early return
  fn_id31561___drop(sm->var_yoa08d9b3a_buffer_2);
  
  // Early return
  sm->result = error_result;
  atomic_store_explicit(&sm->state, -1, memory_order_release);
  __yo_decr_rc((void*)sm);
  return;
}
```

### Option 2: Use RAII-style cleanup with defer/finally

Implement a defer mechanism that ensures cleanup code runs on ALL exit paths.

### Option 3: Dispose function cleanup

Move local variable drops to the dispose function, which is always called when the state machine is freed. However, this requires tracking which variables have been initialized.

## Recommended Approach

**Option 1** is the most straightforward and matches how local variables are handled in regular (non-async) functions. The codegen should:

1. Identify all early return points (completion expressions inside conditional blocks)
2. Before each early return, emit code to drop all local variables that have been initialized
3. Track which variables have been initialized at each point in the control flow

## Files to Modify

- `src/codegen/async/state-machine.ts` - State machine resume function generation
- Specifically, the code that generates completion (result assignment + state transition)

## Test Case

The existing `fixme.yo` test demonstrates this issue - it should complete without memory leaks when run with AddressSanitizer.

## Related Issues

- [async-await-continuation-struct-layout-mismatch.md](async-await-continuation-struct-layout-mismatch.md) - Previous async/await memory leak fix
