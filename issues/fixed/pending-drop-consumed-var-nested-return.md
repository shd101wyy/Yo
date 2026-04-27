# Pending Deferred Drops Fire for Consumed Variables in Nested Returns

## Summary

When all branches of a match/cond return, the branch merge logic excludes all
branches. Variables consumed only within those branches appear "unconsumed" in
the merged environment, causing them to be included in the function body's
`deferredDropExpressions`. These pending drops then fire before every early
return — including `return self` (direct own-parameter return) and
`return Self(...)` after `unsafe.drop(self)`.

## Reproduction

```rust
to_uppercase : (fn(own(self): Self) -> Self)({
  cond(
    (self._len == usize(0)) => return self,   // early return
    true => {
      // All remaining code is in a branch that returns
      if((rc(self) == usize(1)), {
        // mutate in-place
        return self;   // Bug: pending drop for self fires before this return
      });
      // copy path
      unsafe.drop(self);  // explicit drop
      return Self(...);   // Bug: pending drop fires again (double-drop)
    }
  )
});
```

## Root Cause

In `src/evaluator/exprs/cond.ts`, `mergeAndCheckEnvs` (line ~430-438) excludes
branches with return/escape control flow. Variables consumed in return branches
don't propagate to the merged env, causing them to appear unconsumed at the
function body level.

The `generatePendingDeferredDrops` function in `src/codegen/exprs/return.ts`
then includes these variables in pending drops emitted before every early return.

Two sub-cases needed fixing:

1. **`return self` (direct own-param return)**: Fixed by detecting own-parameter
   direct return via `isOwningTheRcValue` check and adding to
   `additionalSkipVarNames`.

2. **`return Self(...)` after `unsafe.drop(self)`**: Fixed by checking
   `!latestVar.consumedAtToken` in the env-based filter of
   `generatePendingDeferredDrops`.

## Fix

In `src/codegen/exprs/return.ts`:

1. Added `additionalSkipVarNames` parameter to `generatePendingDeferredDrops`
2. For direct own-param returns, skip the own variable in pending drops
3. For env-based filter, also check `!latestVar.consumedAtToken` to skip
   variables already consumed by `unsafe.drop`

## Why Vec Worked But String Didn't

In Vec's `push`, the copy path does `unsafe.drop(self); return Self(...)` at the
**top level** of the function body, so `self` IS consumed in the function body's
env. In String's `to_uppercase`, ALL code paths are inside match branches that
return, so `self` appears unconsumed at the function body level.

## Affected Files

- `src/codegen/exprs/return.ts` — `generatePendingDeferredDrops` and `generateReturn`
