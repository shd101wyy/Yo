# An await nested inside an expression in a non-first `cond` arm is silently dropped (wrong value)

**Severity:** S1 — an await nested in a larger expression in an arm or loop body is silently dropped — assignments never run, or a NULL future slot segfaults

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit (`plans/ASYNC_STATE_MACHINE_GENERATION.md`). Reproduces on the v0.2.45 seed and on a tree build of develop `af62bdb28`.

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

## The wider family (shape sweep, 2026-09-28)

The same fall-through drops an await nested in ANY larger expression inside
an arm or a loop body. The first-arm case works only because `x = await(…)`
is on the whitelist.

- `if(c, { x = (x + await); })`: the statement vanishes. Expected
  `0,20,40`, got `0,10,30` (`issues/repros/async-shape-b1a-await-in-binop-in-if-arm-dropped.yo`).
- `y = f(await)` in an arm: a wrong value
  (`issues/repros/async-shape-b1c-await-as-call-arg-in-if-arm-dropped.yo`).
- An arm's tail value `(await + 1)` yields 0
  (`issues/repros/async-shape-b1d-await-in-binop-as-cond-arm-tail-value.yo`).
- `acc = (acc + await)` in a while body gives SIGSEGV, a NULL
  `await_future_0` dereference (`issues/repros/async-shape-b1b-await-in-binop-in-while-body-segv.yo`).
- At the TOP level, `y := io.await(_v(io.await(…)))` (an await inside the
  awaited future's argument) is not rejected: the outer future is built
  with argument 0 and the inner future slot is NULL, so it SIGSEGVs
  (`issues/repros/async-shape-b1e-await-inside-awaited-future-arg-top-level.yo`).
  `_is_ident_bare_await_reassign` and the `:=` path of
  `generate_await_expression` never check the future argument for a nested
  await.

The fall-through sites are `generate_cond_branch_with_await` (its `:=`/`=`
arm acts only on a bare await) and the binding arm of
`generate_while_body_with_await`.

## Fix (2026-09-29)

The silent drop is gone. Every fall-through in the arm emitter (`generate_cond_branch_with_await`) and the while-body emitter (`generate_while_body_with_await`, `src/codegen/async/state_code_gen.yo`), as well as the tail of `generate_remaining_expr_future` (`src/codegen/async/state_machine.yo`), is now a coded user error (E0904) at the await, instead of emitting nothing. The shape is therefore rejected, like the same shape at the body's top level. Phase 5 of `plans/ASYNC_STATE_MACHINE_GENERATION.md` (the single-pass lowering) makes it legal. Regressions: `tests/cli-cases/async-await-in-an-expression-in-an-arm-is-an-error` and `tests/cli-cases/async-await-in-a-while-body-expression-is-an-error`.
