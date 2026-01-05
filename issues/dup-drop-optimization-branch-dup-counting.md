# Dup/Drop Optimization: Incorrect Branch Dup Counting

**Status:** Fixed  
**Date:** 2026-01-05  
**Affected Component:** `src/evaluator/exprs/begin.ts` - dup/drop optimization  

## Problem

The dup/drop optimization was incorrectly counting dup calls from branches (match/cond expressions), treating each branch's dup expression as a separate runtime dup when they actually represent a single runtime dup (since only one branch executes).

## Symptoms

Heap-use-after-free errors when running code with LinkedList operations:

```
ERROR: AddressSanitizer: heap-use-after-free on address 0x508000000128
```

The issue manifested when calling `LinkedList.push_front` multiple times. The generated C code had missing dup calls, leading to reference count underflows.

## Root Cause

In the `push_front` function:

```yo
push_front :: (fn(self: Self, value: T) -> unit)({
  new_node := Node(T)(...);
  
  match(self.head,
    .None => { self.tail = .Some(new_node); },      // Branch 1: uses new_node
    .Some(old_head) => { old_head.prev = .Some(new_node); }  // Branch 2: uses new_node
  );
  
  self.head = .Some(new_node);  // Uses new_node outside branches
  self.length = (self.length + usize(1));
})
```

The optimizer was collecting:
- 1 dup expression from `.None` branch
- 1 dup expression from `.Some` branch  
- 1 dup expression after the match

Total: **3 dup expressions** in the list

However, at runtime:
- Only ONE branch executes → 1 dup call
- After match → 1 dup call

Total: **2 runtime dups**

The optimizer was treating all 3 expressions as separate dups and removing all 3 when it should have only removed 2.

## The Fix

Modified `handleBranchingExpression` in `begin.ts` to mark branch dup groups with a `__branchGroup` property:

```typescript
// Store a marker to identify this as a branch group
const marker = allBranchDupExprs[0]! as FuncCallExpr & { __branchGroup?: FuncCallExpr[] };
marker.__branchGroup = allBranchDupExprs;
dupCalls.get(varName)!.push(marker);
```

Updated the optimization logic to properly count branch groups:

```typescript
for (const dupCallExpr of dupCalls) {
  const marker = dupCallExpr as FuncCallExpr & { __branchGroup?: FuncCallExpr[] };
  if (marker.__branchGroup) {
    // Branch group: counts as 1 runtime dup, but contains multiple expressions
    runtimeDupCount++;
    // When removing, remove ALL expressions in the group
  } else {
    // Regular dup: counts as 1 runtime dup
    runtimeDupCount++;
  }
}
```

## Key Insight

When a variable has dup calls in ALL branches of a match/cond:
- **Runtime behavior:** Only ONE branch executes → ONE dup call happens
- **AST representation:** Multiple dup expressions exist (one per branch)
- **Optimization:** When canceling with a drop, remove ALL branch expressions

The fix ensures branch dup groups count as 1 runtime dup while still removing all the expressions from all branches when optimizing.

## Test Case

The issue was reproducible with:

```yo
list := LinkedList(i32).new();
list.push_front(i32(10));
list.push_front(i32(20));  // Second call triggered the bug
```

After the fix, AddressSanitizer reports no memory errors.
