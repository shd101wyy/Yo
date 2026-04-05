# Index Trait Deref Missing RC Dup

**Status: Fixed** (commit 42ff7e21)

## Problem

When using the Index trait to access elements from a container of RC types (e.g., `ArrayList(String)`), the auto-deref from `*(T)` to `T` did not generate a `___dup` call to increment the reference count. This caused use-after-free when both the local variable and the container were dropped.

## Reproduction

```rust
open import "std/collections/array_list";
open import "std/string";

main :: (fn() -> unit)({
  (list : ArrayList(String)) = ArrayList(String).new();
  list.push(`hello`);
  list.push(`world`);

  (s : String) = list(usize(0));  // No dup generated!
  // s dropped → frees internal bytes (RC goes to 0)
  // list dropped → dispose tries to drop same String → UAF
  ()
});
```

## Root Cause

In `setExprAsNeedsToCallDup` (`src/expr.ts`), the early return check `if (expr.$.value)` treated `UnknownValue` as a compile-time known value. Since the Index trait call result has `UnknownValue` (runtime value with known type) AND `isOwningTheRcValue = false` (non-owning temp from `attachTempVariableToExpr(expr, false)`), the function returned early without generating a dup.

Flow:

1. `parts(pi2)` → Index trait: returns `*(String)`, auto-deref to `String`
2. `attachTempVariableToExpr(expr, false)` → temp marked as NOT owning RC
3. `setExprAsNeedsToCallDup` → `expr.$.value` is `UnknownValue` (truthy) → early return
4. No `___dup` generated → raw struct copy shares RC pointer
5. Local variable drop + container dispose = double-free

## Fix

Changed the early return condition from:

```typescript
if (expr.$.value) {
```

to:

```typescript
if (expr.$.value && !isUnknownValue(expr.$.value)) {
```

`UnknownValue` means "type known, value only at runtime" — it is NOT a compile-time known value. Now the normal dup logic runs for `UnknownValue` expressions, correctly generating `___dup` for RC types accessed through the Index trait.

## Generated C Before/After

Before (broken):

```c
String s = (*index_fn(&list, 0));  // raw copy, no RC increment
drop(s);     // RC → 0, freed
drop(list);  // dispose → UAF
```

After (fixed):

```c
String _temp = (*index_fn(&list, 0));
String _dup = dup(_temp);  // RC incremented
String s = _dup;
drop(s);     // RC → 1
drop(list);  // dispose → RC → 0, properly freed
```

## Impact

This affected ALL code that extracts RC-type elements from containers via the Index trait and assigns them to local variables. Most commonly seen with `ArrayList(String)` in loops.
