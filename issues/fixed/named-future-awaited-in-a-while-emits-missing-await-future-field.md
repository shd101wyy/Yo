# `r := io.await(f, io)` of a NAMED future inside a `while` in `io.async` emits a store to a field that does not exist

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit (`plans/ASYNC_STATE_MACHINE_GENERATION.md`). Reproduces on the v0.2.45 seed and on a tree build of develop `af62bdb28`.

## Symptom

`issues/repros/named-future-awaited-in-a-while-emits-missing-await-future-field.yo`
(also `r1.yo` in the audit's scratch dir):

```rust
f := leaf(i32(1), io);
while(runtime(i < n), {
  v := io.await(f, io);
  …
});
```

```
error: no member named 'await_future_0' in 'struct …_state_t_struct'
      sm->await_future_0 = (void*)(sm->var_f_7493652113323909737);
```

With one extra await before the loop, it fails on `await_future_1`
instead. `yo check` passes. Awaiting the same named future twice OUTSIDE a
loop works (prints `4`).

## Root cause

A named future is never stored in an `await_future_N` slot: the struct
emitter skips the field when `await_point.future_variable_id` is set, and
the await reads the variable's own field. In
`generate_while_body_with_await` (`src/codegen/async/state_code_gen.yo`),
the STANDALONE-await branch checks `future_variable_id` before storing, but
the `x := await(…)` / `x = await(…)` branch calls `emit_await_future_store`
unconditionally.

## Fix direction

Apply the same `future_variable_id` guard in the binding branch, or better,
put the guard inside `emit_await_future_store` itself so that no store
site can get it wrong. Regression test: the repro, and the same with a
captured outer future.

## Fix (2026-09-29)

The binding arm of `generate_while_body_with_await` (`src/codegen/async/state_code_gen.yo`) now checks `await_point.future_variable_id`, as its standalone sibling already did: a named future is read through its own field and never stored into an `await_future_N` slot. Regression: `tests/async/sm_ownership.test.yo`, "a named future awaited inside a while loop" (the batch did not compile before).
