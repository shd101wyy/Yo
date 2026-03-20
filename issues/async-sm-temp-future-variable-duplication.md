# Async State Machine: Temp Future Variable Duplication

## Summary

When an async body contains `io.await(yield())` or `io.await(someExpr())`, the state machine struct may contain **both**:

1. A captured temp variable field (`var_temp_XXXX`) from suspension analysis
2. A separate `await_future_N` field from the await point analysis

Both point to the same future object. Only `await_future_N` is actually used by the resume function logic; the `var_temp_XXXX` field is captured by the variable walker but never referenced during code generation.

## Reproduction

```yo
{ yield } :: import "std/async";

main :: (fn(using(io : IO)) -> unit)({
  task := io.async((using(io : IO)) => {
    io.await(yield());
    return i32(1);
  });
  io.await(task);
});
export main;
```

## Generated struct (observed)

```c
struct state_t_struct {
  // ... fixed fields ...
  sync_fut_t* var_temp_5425;   // ← captured by variable walker
  sync_fut_t* var_temp_5409;   // ← captured by variable walker
  sync_fut_t* await_future_0;  // ← used by resume function
  sync_fut_t* await_future_1;  // ← used by resume function
};
```

## Expected

Only `await_future_N` fields should be present. The `var_temp_XXXX` fields are redundant.

## Root cause

The suspension analysis walks the entire expression tree including temporary variable references inside `io.await(yield())`. The yield call creates a temporary future that the walker captures. Meanwhile, the await-point analysis separately creates `await_future_N` fields for futures without a named variable (`futureVariableId === undefined`).

## Fix

During suspension analysis, skip capturing temporary variables that are the direct argument of a suspension point expression (i.e., the future passed to `io.await`). These are already handled by the `await_future_N` mechanism.

Alternatively, when a captured variable IS the future for an await point, de-duplicate by using the captured variable field as the `await_future` field (the `getFutureFieldName` function already tries to do this, but it doesn't cover temp variables).
