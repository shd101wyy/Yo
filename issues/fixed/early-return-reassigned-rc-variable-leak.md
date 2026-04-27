# Early Return After RC Variable Reassignment — Leak

**Status:** ✅ FIXED (2026-07-15)  
**Date:** 2026-07-11  
**Severity:** Medium (Memory Leak)  
**Related:** [early-return-missing-local-variable-drops.md](early-return-missing-local-variable-drops.md) (fixed, but different variant)

## Problem

When a reference-counted variable (e.g., an `atomic object`) is reassigned inside a loop, and the function returns from within a `match` branch, the **current value** of the variable is not dropped. The codegen correctly drops the "saved old value" temp but misses the live variable itself.

## Reproduction

```rust
replace_all : (fn(self: Self, search: Self, replacement: Self) -> Self)({
  result := Self.new();
  pos := usize(0);
  while runtime(true), {
    match(self.index_of(search, pos),
      .Some(idx) => {
        result = result.concat(...);  // reassignment
        pos = (idx + search._len);
      },
      .None => {
        result = result.concat(self.slice(pos, self._len));  // reassignment
        return result;  // BUG: `result` not dropped, only old saved temp is dropped
      }
    );
  };
  result
})
```

## Generated C (simplified)

```c
case NONE: {
    saved_old = result;              // save old value
    new_val = concat(result, slice); // create new value
    result = new_val;                // reassign

    ret_val = dup(result);           // dup for return
    drop(saved_old);                 // drops old value ✓
    return ret_val;                  // `result` is NEVER dropped ✗
}
```

After return, `result` still holds a reference (RC not decremented), causing a leak.

## Root Cause

The `pendingDeferredDrops` mechanism (from the early-return fix) drops saved "old value" temps and function parameters, but does not drop the **current value** of reassigned local variables when returning from deeply nested control flow (match branch inside while loop).

## Workaround

Avoid `return` after reassignment. Use a condition variable to exit the loop naturally:

```rust
replace_all : (fn(self: Self, search: Self, replacement: Self) -> Self)({
  result := Self.new();
  pos := usize(0);
  done := false;
  while (!(done)), {
    match(self.index_of(search, pos),
      .Some(idx) => {
        result = result.concat(...);
        pos = (idx + search._len);
      },
      .None => {
        result = result.concat(self.slice(pos, self._len));
        done = true;  // exit loop naturally
      }
    );
  };
  result  // returned at function level — properly dropped by caller
})
```

## Impact

Any function that:

1. Has an RC-typed local variable
2. Reassigns that variable inside a loop/match
3. Returns from inside the loop/match

will leak the current value of the variable.

## Fix

In `src/codegen/exprs/return.ts`, after `generatePendingDeferredDrops`, added a call to `generateConsumedVarDropsForEscape` when `handledDeferredDup = true`.

When returning a dup'd borrowed variable:

1. The dup/drop optimizer marks the original as "consumed" (removing it from `pendingDeferredDrops`)
2. The optimizer puts the drop in `consumedVariableDropExpressions` (for escape paths)
3. On an early return-with-dup, `generatePendingDeferredDrops` skips the original (because `consumedAtToken` is set)
4. `generateConsumedVarDropsForEscape` now correctly drops the original after the dup

Regression test added: `tests/rc.test.yo` — "Test early return of reassigned RC variable does not leak".
