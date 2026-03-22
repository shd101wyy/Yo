# Early Return - Missing Local Variable Drops (Regular Functions)

**Status:** ✅ FIXED  
**Date:** 2026-01-05  
**Fixed Date:** 2026-01-05  
**Severity:** High (Memory Leak + Use-After-Free)  
**Related:** [async-early-return-missing-local-variable-drops.md](async-early-return-missing-local-variable-drops.md) (Also Fixed)

## Problem

Regular (non-async) functions that return early from inside loops, conditionals, or match branches do not drop their local variables, causing memory leaks and potential use-after-free errors.

## Example

```yo
has :: (fn(self: Self, value: T) -> bool)({
  current_opt := self.head;  // RC++
  i := usize(0);

  while(i < self.length, i = (i + usize(1)), {
    match(current_opt,
      .None => {
        return false;  // Early return - current_opt is NOT dropped!
      },
      .Some(current) => {
        cond(
          (current.value == value) => {
            return true;  // Early return - current_opt is NOT dropped!
          },
          true => {
            current_opt = current.next;
          }
        );
      }
    );
  });

  false  // Normal path - current_opt IS dropped
})
```

## Symptoms

```
ERROR: AddressSanitizer: heap-use-after-free on address 0x5080000001a8
READ of size 1 at 0x5080000001a8 thread T0
    #0 in __yo_decr_rc
    #1 in fn_id33590___drop
    #2 in fn_id33612___dispose
    #3 in __yo_cleanup_thread_gc
```

The cycle collector frees nodes that still have outstanding references from variables that weren't dropped on early return paths.

## Generated C Code (INCORRECT)

```c
bool fn_id33857_has(__yo_struct_id33491* self, int32_t value) {
  __yo_enum_id33545 current_opt = ...;  // Allocate and initialize

  while (...) {
    switch ((current_opt).tag) {
    case __YO_ENUM_ID33545_NONE:
      bool _yo_temp = false;
      return _yo_temp;  // ❌ NO DROP for current_opt!
      break;
    case __YO_ENUM_ID33545_SOME:
      if (...) {
        bool _yo_temp = true;
        return _yo_temp;  // ❌ NO DROP for current_opt!
      }
      ...
    }
  }

  fn_id33590___drop(current_opt);  // ✓ Only dropped here
  return false;
}
```

## Root Cause

The codegen in `src/codegen/expressions/generation.ts` handled early returns for async state machines but **NOT** for regular functions. The `pendingDeferredDrops` mechanism existed for async but not for regular functions.

## Solution (IMPLEMENTED)

The fix was implemented by adding `pendingDeferredDrops` tracking to regular functions, mirroring the approach already used for async functions.

### Changes Made

#### 1. Function Body Begin Block (`src/codegen/functions/generation.ts`)

Set `pendingDeferredDrops` when generating the function body begin block:

```typescript
export function generateFunctionBody(
  expr: Expr,
  functionType: FunctionType,
  indent: string,
  context: FunctionGenerationContext
): void {
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
  ) {
    // Set pending deferred drops from the function body begin block
    // These need to be generated when early returning from anywhere inside this function
    context.pendingDeferredDrops = expr.$?.deferredDropExpressions;

    // ... generate function body
  }
}
```

#### 2. Nested Begin Blocks (`src/codegen/expressions/generation.ts`)

Save and restore `pendingDeferredDrops` for nested begin blocks:

```typescript
else if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
  const functionContext = context as FunctionGenerationContext;

  if (tempVariableName && valueType) {
    // Expression form: begin block that returns a value
    context.emitter.emitLine(`${indent}{ // begin block`);

    // Set pending deferred drops from this begin block
    const previousPendingDeferredDrops = functionContext.pendingDeferredDrops;
    functionContext.pendingDeferredDrops = expr.$?.deferredDropExpressions;

    // ... generate begin block body ...

    // Restore previous pending deferred drops
    functionContext.pendingDeferredDrops = previousPendingDeferredDrops;
  } else {
    // Statement form: begin block without returning a value
    const previousPendingDeferredDrops = functionContext.pendingDeferredDrops;
    functionContext.pendingDeferredDrops = expr.$?.deferredDropExpressions;

    // ... generate statements ...

    functionContext.pendingDeferredDrops = previousPendingDeferredDrops;
  }
}
```

#### 3. Return Statement Handling (`src/codegen/expressions/generation.ts`)

Emit pending drops before early returns:

```typescript
if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
  // ... handle return value ...

  // Normal (non-state-machine) return

  // Generate pending deferred drops from enclosing begin blocks
  if (
    functionContext.pendingDeferredDrops &&
    (!expr.$.deferredDropExpressions ||
      expr.$.deferredDropExpressions.length === 0)
  ) {
    context.emitter.emitLine(
      `${indent}// Drop local variables before early return`
    );
    for (const dropExpr of functionContext.pendingDeferredDrops) {
      const dropCode = generateExpr(dropExpr, indent, context);
      if (dropCode) {
        context.emitter.emitLine(`${indent}${dropCode};`);
      }
    }
  }

  return `return ${returnValue}`;
}
```

### Generated C Code (FIXED)

```c
bool fn_id33855_has(__yo_struct_id33489* self, int32_t value) {
  __yo_enum_id33543 current_opt = ...;  // Allocate and initialize

  while (...) {
    switch ((current_opt).tag) {
    case __YO_ENUM_ID33543_NONE:
      bool _yo_temp = false;
      // Drop local variables before early return
      fn_id33588___drop(current_opt);  // ✅ NOW DROPPED!
      return _yo_temp;
      break;
    case __YO_ENUM_ID33543_SOME:
      if (...) {
        bool _yo_temp = true;
        // Drop local variables before early return
        fn_id33588___drop(current_opt);  // ✅ NOW DROPPED!
        return _yo_temp;
      }
      ...
    }
  }

  fn_id33590___drop(current_opt);  // ✓ Still dropped here too
  return false;
}
```

### Verification

The fix was verified with AddressSanitizer showing no memory leaks or use-after-free errors:

```bash
$ ./yo-cli compile fixme.yo --release --sanitize address --allocator libc -o test && ./test
Generated C code written to test.c
AddressSanitizer enabled (memory errors + leak detection)
Successfully compiled to test
# Program runs without errors ✅
```

## Remaining Work

This fix handles `return` statements. Similar fixes may be needed for:

- `break` statements (early exit from loops)
- `continue` statements (skipping to next iteration)

These should follow the same pattern: emit pending deferred drops before the control flow statement.

## Priority

**FIXED** - The critical memory safety issue is resolved. Follow-up work for `break`/`continue` can be done as needed.
