# Async/Await Continuation Registration - Struct Layout Mismatch

**Status:** ✅ FIXED  
**Date:** December 30, 2025  
**Severity:** Critical (Memory Leak)

## Problem

Async blocks were not completing and continuations were never being spawned after I/O operations completed, causing memory leaks of 566 bytes across async state machines and related objects.

## Root Cause

The `__yo_async_register_continuation()` function attempted to register continuations on futures using a generic `void*` pointer with a cast to a specific struct type. However, different future types have different memory layouts:

1. **I/O futures (`__yo_io_future_t`):**

   ```c
   struct {
     __yo_ref_header_t header;  // 24 bytes
     _Atomic int state;       // 4 bytes
     int32_t result;          // 4 bytes
     // padding to 8-byte boundary
     _Atomic(void (*)(void*)) continuation_fn;
     _Atomic(void*) continuation_sm;
   }
   ```

2. **Async state machine futures:**
   ```c
   struct {
     __yo_ref_header_t header;  // 24 bytes
     _Atomic int state;       // 4 bytes
     RESULT_TYPE result;      // VARIABLE SIZE (e.g., 8+ bytes for enums)
     _Atomic(void (*)(void*)) continuation_fn;
     _Atomic(void*) continuation_sm;
   }
   ```

The `continuation_fn` and `continuation_sm` fields are at **different offsets** due to the variable size of the `result` field. Casting to the wrong type caused continuations to be written to incorrect memory locations, leaving them as `NULL`.

## Manifestation

```
ASYNC: [IO] Continuation check: cont_fn=(nil), cont_sm=(nil)
```

Even though continuations were "registered", they were written to wrong offsets and appeared as NULL when checked. This prevented async blocks from resuming after I/O completion, causing them to stay at RC=1 forever.

## Solution

Instead of using a generic `__yo_async_register_continuation()` function, continuation registration is now done **inline at each await site** with direct field access:

```c
// Before (broken):
__yo_async_register_continuation(sm->await_future_0, resume_fn, sm);

// After (fixed):
atomic_store_explicit(&sm->await_future_0->continuation_fn, resume_fn, memory_order_release);
atomic_store_explicit(&sm->await_future_0->continuation_sm, sm, memory_order_release);
```

This works because the await codegen knows the exact type of each future variable, allowing correct field access.

## Files Changed

- `src/codegen/async/state-machine.ts` - Inline continuation registration with direct field access
- `src/codegen/async/runtime.ts` - Removed generic `__yo_async_register_continuation()` function
- `src/codegen/functions/generation.ts` - Removed forward declaration
- `src/codegen/expressions/generation.ts` - Added dummy `uint8_t result` field for unit-type futures

## Additional Fix

For unit-type futures (returning `unit`), we now always include a `uint8_t result` field instead of omitting the result field entirely. This keeps struct layouts more consistent, though the direct field access approach doesn't strictly require it.

## Verification

After the fix:

- Async blocks properly complete and are freed (RC goes from 2→1→0)
- Continuations are registered and spawned correctly
- I/O completion handlers successfully resume waiting tasks
- Memory leak reduced from 566 bytes to 190 bytes (remaining leaks are unrelated ArrayList objects)

## Lessons Learned

1. **Avoid generic pointer casting with variable-sized fields** - C struct layouts are predictable but only if you know the exact type
2. **Type-specific code generation is safer than runtime generic code** - The compiler knows the types, use that information
3. **Memory layout assumptions are brittle** - What works for one struct type may fail silently for another
