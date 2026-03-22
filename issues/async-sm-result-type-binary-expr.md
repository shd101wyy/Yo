# Async SM Result Type Wrong for Binary Expression Return

**Status:** ✅ FIXED  
**Date:** March 20, 2026  
**Severity:** Medium (workaround exists: assign to variable before returning)  
**Fixed:** Evaluator now follows SomeType resolution chain for async closure body types. Codegen also defensively resolves SomeType for SM and sync_fut_t paths.

## Problem

When an async block's last expression (return value) is a binary operation like `(a + b)`,
the generated C state machine struct uses `void* result` instead of the correct type
(e.g., `int32_t result`). This causes a C compilation error:

```
error: incompatible integer to pointer conversion assigning to 'void *' from 'int32_t'
```

## Reproducer

```yo
open import "std/libc/stdio";
open import "std/string";
open import "std/fmt";
{ yield } :: import "std/async";

main :: (fn(using(io : IO)) -> unit) {
  task := io.async((using(io : IO)) => {
    a := i32(5);
    io.await(yield());
    b := i32(10);
    (a + b)      // BUG: result type is void* instead of i32
  });

  result := io.await(task);
  printf("result: %d\n", result);
};

export main;
```

## Generated C (incorrect)

```c
struct _state_t_struct {
  __yo_ref_header_t header;
  int state;
  void* result;    // ← BUG: should be int32_t
  ...
};

// In resume function:
sm->result = ((sm->var_a) + (sm->var_b));  // int32_t → void* error
```

## Workaround

Assign the expression to a variable and return the variable:

```yo
task := io.async((using(io : IO)) => {
  a := i32(5);
  io.await(yield());
  b := i32(10);
  r := (a + b);  // assign to variable
  r              // return variable — works correctly
});
```

## Analysis

The SM result type is likely determined from the closure's return expression AST type.
When the last expression is a binary operation, the codegen may fail to extract the
type correctly (possibly getting `undefined` and falling back to `void*`), while
returning a simple variable works because its type is directly available from the
variable's stored type info.

## Affected Code

- `src/codegen/exprs/async.ts` — SM struct definition, result type determination
- Related: how the return expression type is inferred for the SM struct layout
