# Async State Machine: Unnecessary Local Variable Storage

## Summary

The async state machine struct stores ALL local variables referenced in the async body, regardless of whether they cross await boundaries. Variables defined and consumed entirely within a single state segment should remain as C local variables in that segment's case block, not as struct fields.

## Reproduction

```rust
{ yield } :: import "std/async";

main :: (fn(using(io : IO)) -> unit)({
  task := io.async((using(io : IO)) => {
    a := i32(1);
    b := i32(2);       // only used in segment 0
    io.await(yield());
    c := i32(3);
    d := i32(4);       // only used in segment 1
    io.await(yield());
    e := (a + c);       // only uses a and c, which cross boundaries
    return e;
  });
  result := io.await(task);
});
export main;
```

## Generated struct (current)

```c
struct state_t_struct {
  __yo_ref_header_t header;
  int state;
  int32_t result;
  void (*continuation_fn)(void*);
  void* continuation_sm;
  void (*__yo_resume_fn)(void*);
  __yo_struct __capture;
  // Local variables
  int32_t var_a;  // a — crosses await (used in segment 2) ✓ NEEDED
  int32_t var_b;  // b — only in segment 0 ✗ UNNECESSARY
  int32_t var_c;  // c — crosses await (used in segment 2) ✓ NEEDED
  int32_t var_d;  // d — only in segment 1 ✗ UNNECESSARY
  int32_t var_e;  // e — only in segment 2 ✗ UNNECESSARY
  sync_fut_t* var_temp_1;  // yield() future — temp ✗ UNNECESSARY
  sync_fut_t* var_temp_2;  // yield() future — temp ✗ UNNECESSARY
  sync_fut_t* await_future_0;
  sync_fut_t* await_future_1;
};
```

## Expected struct (after optimization)

```c
struct state_t_struct {
  __yo_ref_header_t header;
  int state;
  int32_t result;
  void (*continuation_fn)(void*);
  void* continuation_sm;
  void (*__yo_resume_fn)(void*);
  __yo_struct __capture;
  // Local variables (only those crossing await boundaries)
  int32_t var_a;  // a — used in segments 0 and 2
  int32_t var_c;  // c — used in segments 1 and 2
  sync_fut_t* await_future_0;
  sync_fut_t* await_future_1;
};
```

Variables `b`, `d`, `e` would become C local variables in their respective `case` blocks.

## Root cause

In `src/evaluator/shared/suspension-analysis.ts`, the `walkExpr` function captures every variable it encounters during the tree walk. There is no liveness analysis to determine whether a variable actually crosses a suspension point.

Additionally, `getLocalVariablesFromBody()` in `await-analysis.ts` collects ALL `let`/`:=` bindings in the body, which are all added to `analysis.capturedVariables`.

## Impact

- State machine structs are larger than necessary
- More memory per concurrent task
- Worse cache utilization for high-concurrency workloads
- Unnecessary initialization/cleanup of struct fields

## Status: FIXED

All planned optimizations have been implemented:

**Phase 1** — Liveness analysis (`computeCrossBoundaryVariables()`): segment-local variables are emitted as C locals instead of struct fields.

**Phase 1b** — Temp future aliasing: `io.await(yield())` temp vars alias to `await_future_N` fields via `stateMachineFieldAliases`.

**Phase 2** — Overlapping storage: same-type non-RC value variables with non-overlapping live ranges share `slot_N` struct fields via greedy graph coloring (`computeOverlappingSlots()`).

**Phase 2b** — Per-segment cond/while analysis: only variables in branching segments are conservatively kept in struct; other segments benefit from C-local optimization.

**Phase 3** — Await result deduplication: linear awaits skip `await_result_N` intermediate struct fields; results assigned directly to target variables.

See `plans/archive/ASYNC_SM_VARIABLE_OPTIMIZATION.md` for the full optimization plan and implementation details.
