# Async while loop condition re-evaluation: undeclared temp variables

## Status: FIXED

## Summary

In async state machines, while loop conditions are generated twice — once for the initial check and once for the re-evaluation at the `while_loop_N_continue` label. The `declaredTempVars` set (added to prevent duplicate declarations in begin block dup handling) incorrectly prevented re-declaration of temp variables during the second generation, causing C compilation errors.

## Root Cause

Commit `4b1b888b` added `declaredTempVars` tracking to `FunctionGenerationContext` to prevent duplicate temp variable declarations when begin block dup handling re-traverses sub-expressions. However, in async while loops, the condition expression is generated twice into different C scopes:

1. **First evaluation** (at `while_loop_0_start`): declares `temp_19993` inside a begin block scope
2. **Re-evaluation** (at `while_loop_0_continue`): references `temp_19993` but skips declaration because it's already in `declaredTempVars`

Since the two evaluations are in different C scopes, the second one needs its own declarations.

## Reproduction

Any async function with `while runtime(!(done))` where the condition involves a function call (e.g., `not_bool`):

```rust
read_bytes : (fn(self: Self, using(io : IO)) -> Impl(Future(ArrayList(u8), IO, Exception)))({
  // ...
  done := false;
  while runtime(!(done)), {
    n := io.await(IO_tcp.recv(fd, buf, buf_size, i32(0)));
    // ...
  };
})
```

The `!(done)` expands to a begin block with a `not_bool` call producing a temp variable.

## Fix

Save and restore `declaredTempVars` around while loop condition/step re-evaluation in `state-machine.ts`, at both the inner while continue point and the outer while continue point. Setting it to `undefined` before re-generation allows all temp variables to be freshly declared.

## Files Changed

- `src/codegen/async/state-machine.ts` — save/restore `declaredTempVars` at both while loop re-evaluation sites
