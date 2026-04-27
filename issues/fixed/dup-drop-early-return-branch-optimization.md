# Dup/Drop Optimization Not Working for Early Return Branches

## Problem

The dup/drop optimization was incorrectly blocking optimization for variables used in early return branches when there was a non-empty fallthrough branch that didn't use the variable.

## Example

```rust
Path :: object(
  _segments: ArrayList(Box(i32)),

  new :: (fn(path_str: Box(i32)) -> Self)({
    segments := ArrayList(Box(i32)).new();

    cond(
      (path_str.* == 1) => {
        return Self(_segments: segments);  // Early return, uses segments
      },
      true => {
        x := 12;  // Non-empty branch that doesn't use segments
        16
      }
    );

    return Self(_segments: segments);  // Normal return, uses segments
  })
);
```

### Expected Behavior

Both the early return path and normal return path should have their dup/drop pairs optimized away since:

- Early return: `segments` is moved into the constructor, then function returns
- Normal return: `segments` is moved into the constructor, then function returns

The variable is consumed on all paths, so no dup/drop is needed.

### Actual Behavior (Before Fix)

The compiler generated unnecessary dup/drop pairs:

```c
if (condition) {
  // Early return branch
  __yo_struct* temp = fn___dup(segments);        // Unnecessary dup
  __yo_struct* result = __yo_new(..., temp);
  fn___drop(segments);                          // Unnecessary drop
  return result;
}
// Normal return
__yo_struct* temp = fn___dup(segments);          // Unnecessary dup
__yo_struct* result = __yo_new(..., temp);
fn___drop(segments);                            // Unnecessary drop
return result;
```

## Root Cause

Two issues were found:

### Issue 1: Incorrect Branch Classification Logic

The old logic in `handleBranchingExpression` checked if ANY non-empty fallthrough branch didn't have a dup for a variable, and if so, marked the variable as having "partial branch dups" (blocking optimization).

```typescript
// Old incorrect logic
if (!hasDup && !isEmpty && !hasReturn) {
  hasNonEmptyBranchWithoutDup = true; // Blocks optimization!
}
```

This was wrong because:

1. **Early return branches are independent**: Each has its own dup+drop pair that can be optimized
2. **Fallthrough branches that don't use the variable don't matter**: If a branch doesn't dup a variable, it means the branch doesn't use it - this doesn't affect the variable's optimization
3. **Only fallthrough branches with inconsistent dups matter**: If SOME fallthrough branches dup a variable but others don't, that's when we can't optimize

### Issue 2: Unit Value Detection Bug

The `branchIsEmptyOrUnit` function checked for `"()"` but the parser represents unit `()` as a call to `tuple` with 0 args:

```typescript
// Wrong
exprIsFunctionCallOf(branchBody, "()", 0);

// Correct
exprIsFunctionCallOf(branchBody, BuiltinKeywords.tuple, 0);
```

This caused branches like `true => ()` to not be recognized as empty.

## Fix

### Fix 1: Separate Early Return and Fallthrough Logic

```typescript
// New correct logic
for (const varId of allVarsWithDups) {
  const earlyReturnBranchDups: FnCallExpr[] = [];
  const fallthroughBranchDups: FnCallExpr[] = [];

  for (let i = 0; i < branchDupCalls.length; i++) {
    const hasDup = branchDupCalls[i]!.dupCalls.has(varId);
    const hasReturn = branchHasReturn[i]!;

    if (hasDup) {
      if (hasReturn) {
        // Early return: independent dup+drop pair
        earlyReturnBranchDups.push(...dups);
      } else {
        // Fallthrough: shares drop with code after cond
        fallthroughBranchDups.push(...dups);
      }
    }
    // Branches without dup don't affect optimization for THIS variable
  }

  // Early return dups can always be optimized
  for (const dupExpr of earlyReturnBranchDups) {
    dupCalls.get(varId)!.push(dupExpr);
  }

  // Fallthrough dups: only partial if not ALL fallthrough branches have dup
  if (fallthroughBranchDups.length > 0) {
    let fallthroughBranchCount = 0;
    let fallthroughBranchesWithDup = 0;
    for (let i = 0; i < branchDupCalls.length; i++) {
      if (!branchHasReturn[i]) {
        fallthroughBranchCount++;
        if (branchDupCalls[i]!.dupCalls.has(varId)) {
          fallthroughBranchesWithDup++;
        }
      }
    }

    if (fallthroughBranchesWithDup === fallthroughBranchCount) {
      // All fallthrough branches have dup - can optimize
      for (const dupExpr of fallthroughBranchDups) {
        dupCalls.get(varId)!.push(dupExpr);
      }
    } else {
      // Partial - can't optimize
      varsWithPartialBranchDups.add(varId);
    }
  }
}
```

### Fix 2: Use BuiltinKeywords.tuple for Unit Detection

```typescript
// Check for unit literal () - parsed as tuple() with 0 args
if (
  exprIsFunctionCall(branchBody) &&
  exprIsFunctionCallOf(branchBody, BuiltinKeywords.tuple, 0)
) {
  return true;
}
```

## Key Insight

The key insight is that **early return branches are independent execution paths**. When a branch returns early:

- It has its own dup (for the return value)
- It has its own drop (at the return point, part of pendingDeferredDrops)
- The optimization can match and cancel these independently

Fallthrough branches that don't use a variable don't affect that variable's optimization - they simply don't interact with the variable at all.

## Files Changed

- `src/evaluator/exprs/begin.ts`: Fixed `handleBranchingExpression` and `branchIsEmptyOrUnit`

## Test Case

```rust
Path :: object(
  _segments: ArrayList(Box(i32)),
  new :: (fn(path_str: Box(i32)) -> Self)({
    segments := ArrayList(Box(i32)).new();
    cond(
      (path_str.* == 1) => { return Self(_segments: segments); },
      true => { x := 12; 16 }  // Non-empty, doesn't use segments
    );
    return Self(_segments: segments);
  })
);
```

After fix, generated C shows `segments` passed directly without dup/drop:

```c
if (condition) {
  __yo_struct* result = __yo_new_...(segments);
  return result;
}
// ...
__yo_struct* result = __yo_new_...(segments);
return result;
```
