# An await nested inside an expression in a non-first `cond` arm is silently dropped (wrong value)

**Status: OPEN.** Found 2026-09-28 by the async state-machine audit (`plans/backlog/ASYNC_STATE_MACHINE_GENERATION.md`). Reproduces on the v0.2.45 seed and on a tree build of develop `af62bdb28`.

## Symptom

`issues/repros/await-inside-an-expression-in-a-later-cond-arm-is-dropped.yo`:

```rust
cond(
  (k == i32(0)) => { out = io.await(leaf(k, io), io); },
  (k == i32(1)) => { out = (io.await(leaf(k, io), io) + i32(10)); },
  true          => { out = (io.await(leaf(k, io), io) + i32(20)); }
);
```

```
branchy:  1 0 0 (want 1 12 23)
branchy2: 1 12 23 (want 1 12 23)      # the same with `t := io.await(…); out = (t + …)`
```

`yo check` is clean and clang is clean: the value is silently wrong. In the
emitted C, arms 2 and 3 only set `cond_branch_0`. The future is never
created, and the assignment never runs.

## Root cause

The await-placement rule says an await nested inside a larger expression is
unsupported (`expr_is_bare_await`'s comment: "Awaits nested inside a bigger
expression are unsupported everywhere"), but nothing enforces it for a
branch VALUE. The cond emitter
(`_generate_cond_with_await_impl` / `generate_cond_branch_with_await`,
`src/codegen/async/state_code_gen.yo`) recognises only the shapes
`x = await(…)`, `x := await(…)` and a bare `await(…)`. Any other statement
containing an await falls through the dispatcher without an error, and
without the code.

## Fix direction

Immediately: every fall-through in the branch emitters becomes a
`codegen_user_error` (E0904-family) rather than silent omission. That turns
this into a compile error. Plan phase 1 (statement-position normalisation)
then makes the shape legal: `out = (await(f) + 10)` becomes
`t := await(f); out = (t + 10)`.
