# `return(io.await(...))` is rejected with E0904 inside an `io.async` block

**Status: FIXED (2026-09-27).** Found 2026-09-27
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
bare `io.await(...)` as that argument can be hoisted without changing meaning.
The hoist machinery, however, assumes the moved expression only reads the
value, so it has to learn that a `return` both reads it and completes the
state machine (below).

## Fix direction explored first (reverted)

Adding `return(<bare await>)` to `await_is_in_non_splittable_position`, so that
the state machine hoists it, is not enough (measured on a tree build):

1. The state struct allocates `await_result_N` only for awaits flagged
   `is_inside_cond`, `is_body_result` or a `while` condition. The hoisted
   `return(sm->await_result_N)` read a field that did not exist.
2. The hoisted `return`'s completion block and the segment's own completion
   landed in one C scope (`redefinition of 'continuation_fn'`).

## Fix (landed)

A parse-time lowering, next to `if` → `cond` in `desugar_if_calls`
(`src/expr.yo`):

```rust
return(x.await(...))   →   begin(__yo_return_await_N := x.await(...), return(__yo_return_await_N))
```

- The two forms mean the same thing in every context, sync or async.
- The second is the shape the state machine splits at in every position: the
  value of a `:=` is a state boundary at top level, in a `cond` branch and in a
  loop body.
- The match is syntactic: a `<recv>.await(...)` method call is the whole
  argument of `return`, the same shapes the await analysis recognises.
- The temp is a compiler-minted `__yo_` name, unique per node. The `__yo`
  prefix is deliberately not reserved for user code yet.
- `yo fmt` works on the token stream, so the user's spelling is preserved.
- The E0904 explanation (en + zh) lists `return(...)` among the supported
  positions.

## Regression tests

In `tests/async_await.test.yo`:
- a top-level `return(io.await(...))`;
- the same for an RC value (`String`);
- the same inside a `cond` branch.

`tests/sys/socketpair.test.yo` uses the direct form in an aborted task.
