# `out = e.io.await(...)` — re-assigning an await result to an EXISTING variable silently no-oped the await

**Status: FIXED 2026-08-27.** Found by D5's BufReader "large read bypasses the
buffer" test: the bypass branch's `out = e.io.await(self._inner.read(...), e)`
never ran — `read` returned the refill count (8) instead of the bypass count
(64). Pre-existing on develop; SILENT wrong values, no diagnostic.

## Symptom

An async body that RE-assigns an await result to an existing variable
(`=`, not `:=`), inside a cond/match branch:

```rust
(out : usize) = usize(0);
cond(
  (which == usize(1)) => {
    out = e.io.await(give_a(io), e);   // this whole branch silently no-ops
    done = true;
  },
  true => ()
);
```

The emitted C records the branch (`sm->cond_branch_N = 1;`) but emits **no
future store** — `sm->await_future_N` stays NULL, the "only await if the
branch with await was taken" guard skips ahead, and neither the assignment
nor the rest of the branch executes. Every call returns the fallthrough
value. `x := e.io.await(...)` (a fresh binding) was always fine.

## Mechanism

Three await-statement recognizers guarded on `:=` only, so the `=` form fell
through every arm and emitted/extracted nothing:

- `extract_target_variable_id` (`src/evaluator/shared/suspension_analysis.yo`)
  — returned `.None` for `=` parents, so the await point had no target and
  the result extraction wrote nowhere;
- `generate_await_expression` (`src/codegen/async/state_code_gen.yo`) — the
  linear-path future store;
- `generate_cond_branch_with_await` (same file) — the cond-branch future
  store, whose miss is what NULLed `await_future_N`.

All three now also accept the two-argument `=` form. The target of `=`
already exists in the enclosing scope (it is an sm-hoisted local), so the
extraction's existing `sm-><field> = future->result` write needs nothing new.

## Verification

- Red-first: `tests/async_assign_await.test.yo` (the sibling-cond shape with
  all three outcomes pinned + the linear shape) — rc=1 on the pre-fix
  develop binary, 2/2 after.
- `tests/io/bufio.test.yo`'s bypass test (the discovery site) goes 10/11 →
  11/11 with it.
