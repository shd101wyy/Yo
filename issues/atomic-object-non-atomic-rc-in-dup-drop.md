# Atomic Object **_dup/_**drop Used Non-Atomic RC Operations

## Bug

The compiler-generated `___dup` and `___drop` functions for `atomic object` types used non-atomic RC operations (`__yo_incr_rc`/`__yo_decr_rc`) instead of atomic ones (`__yo_incr_rc_atomic`/`__yo_decr_rc_atomic`).

## Impact

When an `atomic object` was shared across threads (its intended use case), concurrent `___dup`/`___drop` calls from different threads caused **mixed atomic/non-atomic access** to the same reference count — undefined behavior in C11.

This manifested as a flaky crash (signal/exit code null) in the full test suite when running with `--parallel 4`, specifically in `tests/sync/once.test.yo`'s "multiple threads race to call" test. The test passed reliably in isolation because system load was lower.

## Root Cause

In `src/evaluator/types/utils.ts`, the functions `generateDropFunctionCodeForStructType` and `generateDupFunctionCodeForStructType` always used `BuiltinFunctions.__yo_decr_rc` / `BuiltinFunctions.__yo_incr_rc` for RC types, without checking `structType.isAtomicRc`.

Meanwhile, the **inline** codegen in `src/codegen/exprs/drop-dup.ts` correctly checked `isAtomicObjectType` and used atomic RC operations. This inconsistency meant:

- Inline dup/drop of atomic objects → `__yo_incr_rc_atomic` / `__yo_decr_rc_atomic` ✓
- `___dup`/`___drop` function bodies for atomic objects → `__yo_incr_rc` / `__yo_decr_rc` ✗

When a thread called the `___dup` function while another thread performed inline dup (atomic), TSan detected a data race on the same RC counter.

## Fix

In `generateDropFunctionCodeForStructType` and `generateDupFunctionCodeForStructType`, check `structType.isAtomicRc` to select the appropriate RC function:

```typescript
const decrRcFn = structType.isAtomicRc
  ? BuiltinFunctions.__yo_decr_rc_atomic[0]!
  : BuiltinFunctions.__yo_decr_rc[0]!;

const incrRcFn = structType.isAtomicRc
  ? BuiltinFunctions.__yo_incr_rc_atomic[0]!
  : BuiltinFunctions.__yo_incr_rc[0]!;
```

## Verification

- TSan no longer reports RC data races on atomic objects
- The remaining TSan warning in the Once stress test is a benign, intentional double-checked locking pattern (non-locked read of `_done` in the fast path)
- All atomic*object, imm_threading, sync/once, and imm*\* tests pass

## Files Changed

- `src/evaluator/types/utils.ts`: Lines 425-431 (drop) and 469-475 (dup)
