# `return(io.await(...))` is rejected with E0904 inside an `io.async` block

**Status: OPEN — fix written, awaiting a tree build to verify.** Found 2026-09-27
while writing `tests/sys/socketpair.test.yo`.

## Symptom (measured, v0.2.44 seed)

```rust
fut := io.async((io : Io) => {
  return(io.await(sleep(u64(1)), io));
});
```

```
error[E0904]: `io.await` is not supported in this position inside an `io.async` block (expression: FnCall, function: `return`).
Hoist it into a local first: `result := io.await(f, io);`
```

The suggested workaround (`n := io.await(...); return(n);`) compiles. The
rejected form is the more natural spelling, and it is not ambiguous.

## Root cause

An `io.async` body that awaits is split into states at each await
(`src/codegen/async/state_code_gen.yo`). An await nested in an expression that
cannot be split at it is handled by `hoist_non_splittable_awaits`. The await
point ends state N, and the enclosing expression moves to the front of state
N+1, where `sm->await_result_N` holds the value. That is exact when the await is
evaluated exactly once, before anything else in the enclosing expression.
`await_is_in_non_splittable_position` recognised only three such shapes: the
first `cond` condition, the `if` condition and the `match` scrutinee. Any other
enclosing expression fell through to the E0904 diagnostic.

`return(x)` evaluates its single argument exactly once, before returning, so a
bare `io.await(...)` as that argument hoists exactly. It was simply missing
from the list.

## Fix

`await_is_in_non_splittable_position` accepts `return(<bare await>)`. The E0904
explanation in `src/diagnostics_registry.yo` (en + zh) lists `return(...)` among
the supported positions.

## Regression tests

In `tests/async_await.test.yo`:
- "return(io.await(...)) inside io.async returns the awaited value";
- the same for an RC value (a `String`, to catch a missing or doubled release on
  the hoisted path);
- the same inside a `cond` branch.
