# Async SM Codegen Doesn't Support 3-Argument While Loop

**Status:** ✅ FIXED  
**Date:** March 20, 2026  
**Severity:** Medium (workaround: use 2-argument form with manual step)  
**Fixed:** state-code-gen.ts now accepts 2 or 3 args, extracts step expression, stores in whileLoopInfo. state-machine.ts generates step code in resume states for both inner and outer while loops.

## Problem

The async state machine codegen only supports the 2-argument `while` form
(`while condition, body`). The 3-argument form with a step expression
(`while condition, step, body`) emits an error comment in the C output and
generates a broken state machine, typically causing a segfault at runtime.

## Reproducer

```yo
// This crashes:
task := io.async((using(io : IO)) => {
  counter := Box(i32)(0);
  while runtime(counter.* < i32(4)), counter.* = (counter.* + i32(1)), {
    io.await(yield());
  };
  counter.*
});
```

## Generated C (broken)

```c
case 0: {
  // Error: while must have exactly 2 arguments (condition, body)
  // Transition to next state after await
  ...
}
```

The comment `Error: while must have exactly 2 arguments (condition, body)` is
emitted directly in the C output, and the state machine states are not properly
generated.

## Workaround

Use the 2-argument form and put the step expression inside the loop body:

```yo
task := io.async((using(io : IO)) => {
  counter := Box(i32)(0);
  while runtime(counter.* < i32(4)), {
    io.await(yield());
    counter.* = (counter.* + i32(1));
  };
  counter.*
});
```

## Affected Code

- `src/codegen/exprs/async.ts` — while loop SM state generation, only handles
  2-argument case (condition + body), needs extension for 3-argument case
  (condition + step + body)
