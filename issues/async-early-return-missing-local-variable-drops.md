# Async Early Return - Missing Local Variable Drops

**Status:** ✅ FIXED  
**Date:** December 30, 2025 (Fixed: December 31, 2025)  
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

### Generated C Code (BEFORE FIX)

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

## Solution (IMPLEMENTED)

### Fix 1: Zero-initialize `yo_io_future_t`

In `src/codegen/async/runtime.ts`, added `memset` to zero-initialize the future struct in both `__yo_async_read_start` and `__yo_async_write_start`:

```c
memset(future, 0, sizeof(yo_io_future_t));  // Zero-initialize to ensure dispose_fn etc. are NULL
```

This prevents segfaults when dropping a future that was allocated but not fully initialized.

### Fix 2: Track and generate pending deferred drops for early async completion

Added a `pendingDeferredDrops` field to `FunctionGenerationContext` (`src/codegen/functions/context.ts`):

```typescript
// Pending deferred drops from enclosing begin blocks that need to run before async completion
pendingDeferredDrops?: import("../../expr").Expr[];
```

In `src/codegen/async/state-machine.ts`, populate this field before generating state segment code:

```typescript
// Set pending deferred drops so early returns can drop local variables
functionContext.pendingDeferredDrops = bodyExpr.$?.deferredDropExpressions;

// Generate code for this segment
generateStateSegmentCode(segment, context);

// Clear pending drops after segment
functionContext.pendingDeferredDrops = undefined;
```

In `src/codegen/expressions/generation.ts`, generate pending drops before early async completion:

```typescript
// Generate pending deferred drops from enclosing begin blocks
// Only generate these if the return expression doesn't already have its own
// deferred drops (to avoid double-dropping).
if (
  functionContext.pendingDeferredDrops &&
  (!expr.$.deferredDropExpressions ||
    expr.$.deferredDropExpressions.length === 0)
) {
  context.emitter.emitLine(
    `${indent}// Drop local variables before early completion`,
  );
  for (const dropExpr of functionContext.pendingDeferredDrops) {
    const dropCode = generateExpr(dropExpr, indent, context);
    if (dropCode) {
      context.emitter.emitLine(`${indent}${dropCode};`);
    }
  }
}
```

### Generated C Code (AFTER FIX)

```c
case 1: { // State 1
  // ... code ...
  if (result < 0) {
    // error path - falls through to normal deferred drops
  } else {
    // success path
    // Drop local variables before early completion
    if (sm->var_io_future != NULL) { __yo_decr_rc((void*)sm->var_io_future); };
    fn_drop(sm->var_buffer);
    // Final state - complete the result Future
    sm->result = ok_result;
    atomic_store_explicit(&sm->state, -1, memory_order_release);
    // ...
    return;
  }

  // Normal deferred drops (for error path)
  if (sm->var_io_future != NULL) { __yo_decr_rc((void*)sm->var_io_future); };
  fn_drop(sm->var_buffer);
}
```

## Testing

```bash
./yo-cli compile src/tests/examples/fixme.yo --release --sanitize address -o test_fixme && ./test_fixme
```

Before fix: 190 bytes leaked in 3 allocations
After fix: No leaks detected

## Related Files

- `src/codegen/async/runtime.ts` - Zero-initialization fix
- `src/codegen/async/state-machine.ts` - Pending drops tracking
- `src/codegen/expressions/generation.ts` - Early return drop generation
- `src/codegen/functions/context.ts` - pendingDeferredDrops field

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
