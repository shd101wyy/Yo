# Multiple `io.await` calls in a while loop body generate invalid C

## Status

**Fixed** — state machine codegen now chains multiple await points in while loop bodies across successive states.

## Symptom

When an async function contains a `while` loop whose body has **two or more** `io.await` calls, the generated C code contains an empty expression:

```c
int32_t _yo_..._temp_39225 = ;   // <-- missing RHS
```

This causes a C compilation error (`expected expression`).

## Minimal reproduction

```rust
main :: (fn(using(io : IO)) -> unit)({
  task := io.async((using(io : IO)) => {
    fd := io.await(IO_tcp.socket(AF_INET, SOCK_STREAM, i32(0)));
    done := false;
    while runtime(!(done)), {
      r1 := io.await(IO_tcp.close(fd));  // first await — works fine
      r2 := io.await(IO_tcp.close(fd));  // second await — generated `temp = ;`
      done = true;
    };
  });
  io.await(task);
});
```

## Root cause

The state machine codegen for while-loop-with-await (`state-machine.ts`) only handled the **first** `io.await` in a while loop body. It correctly:

1. Split the body at the first await point
2. Set up the future (`sm->await_future_N = ...`)
3. Stored remaining body expressions in `asyncWhileLoopInfo.bodyExprsAfterAwait`

The **resume handler** for the next state then naively iterated through `bodyExprsAfterAwait` calling `generateExpr()` on each. But `io.await` expressions cannot be generated through `generateExpr` in a state machine context — they require the full suspension/resume machinery (future field setup, state transition, continuation registration). The result was an empty expression for the second await's result extraction.

### State machine segment layout (before fix)

```
Segment 0: [fd := io.await(socket)]     awaitPoint=0
Segment 1: [done := false, while(...)]  awaitPoint=1 (first while-body await)
Segment 2: []                           awaitPoint=2 (second while-body await — empty!)
Segment 3: []                           awaitPoint=null (completion)
```

`handleSequentialSuspensions` correctly created segment 2 for the second await, but the resume handler for state 2 didn't know it was part of a while loop body because `asyncWhileLoopInfo` was only set for key 1 (the first await).

## Fix

The fix chains multiple await points within a while loop body across successive states:

1. **Detect additional awaits** — When processing `bodyExprsAfterAwait`, if an expression contains `io.await` (detected via `exprContainsAwait`), stop generating expressions and set up chaining.

2. **Chain to next state** — Call `generateRemainingExprFuture()` to set up the future for the next await. Register a **new** `asyncWhileLoopInfo` entry keyed on the current segment's await index, carrying the further remaining expressions.

3. **Skip loop-back code for chained states** — Chained intermediate states close the `while_loop_active` block but do NOT emit the continue label, condition check, or loop-back goto. Only the **final** chained state (the one with no more awaits in its remaining expressions) emits the full loop-back machinery.

4. **Origin-aware indexing** — All while-loop-related C identifiers (`while_loop_N_active`, `while_loop_N_start`, `while_loop_N_continue`, `after_while_loop_N`) use the **original** while loop's await index, not the current chained state's index. The `whileLoopOriginIndex` field tracks this.

### Key files changed

- `src/codegen/async/state-machine.ts` — Main fix: await detection in remaining expressions, chaining logic, origin-aware loop-back
- `src/codegen/functions/context.ts` — Added `whileLoopOriginIndex` and `isChainedAwait` fields to `asyncWhileLoopInfo` type

### Tests added

- `tests/async_await.test.yo`:
  - "Regression: multiple awaits in while loop body" — 2 awaits with `yield()`
  - "Regression: two awaits in while loop with result values" — 2 awaits returning values from nested `io.async`
  - "Regression: three awaits in while loop body" — 3 awaits (chains twice)
