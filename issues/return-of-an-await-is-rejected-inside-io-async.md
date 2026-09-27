# `return(io.await(...))` is rejected with E0904 inside an `io.async` block

**Status: OPEN.** Found 2026-09-27
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

## Fix direction (a first attempt, reverted, taught two things)

Adding `return(<bare await>)` to `await_is_in_non_splittable_position` is **not
enough** (measured on a tree build, 2026-09-27):

1. The state struct allocates `await_result_N` only for awaits flagged
   `is_inside_cond`, `is_body_result` or a `while` condition
   (`src/codegen/exprs/async.yo` ~l.724, `src/codegen/async/state_machine.yo`
   ~l.2397). The hoisted `return(sm->await_result_N)` then read a field that did
   not exist.
2. The hoisted `return` emits its completion block, and the segment's own
   completion followed it in the same C scope (`redefinition of
   'continuation_fn'`).

A complete fix either:
- marks the await as needing its result field and makes the segment's
  completion defer to the hoisted `return`; or
- lowers `return(<await>)` to `{ tmp := <await>; return(tmp); }` before
  evaluation, which is the form the state machine supports in every position.

Either way, the regression tests go in `tests/async_await.test.yo`: a top-level
return of an awaited value, an RC value, and the same inside a `cond` branch.
