# In an `io.async` body, a value-producing cond/match arm loses its tail value once the arm awaits a second time

**Status:** FIXED 2026-09-11 (`fix/async-nested-match-dead-arm`, with the nested-dispatch fix).
**Found:** 2026-09-11 while gating that fix — the `yo install` shape's test
returned `""` on the pre-fix compiler with the nested match REMOVED, so this is
a separate, older bug in the chained-layer emitter.
**Severity:** high — the compile succeeds, `check` is clean, and the bound
result is silently zeroed (an empty `String`, `.None`, `0`).

## Reproducer

`issues/repros/async-cond-arm-tail-value-lost-after-second-await.yo`:

```rust
out := cond(
  flag => {
    a := e.io.await(resolve(String.from("a"), e.io), e);
    b := e.io.await(resolve(String.from("b"), e.io), e);
    `${a}|${b}`            // computed, then DISCARDED — `out` stays ""
  },
  true => String.from("no")
);
out
```

Two sibling shapes fail the same way, and a third emits nothing at all:

| shape | pre-fix result |
| --- | --- |
| `out := match(…, .Git => { a := await …; b := await …; \`${a}${b}\` })` | `out == ""` |
| `out := match(…, .Git => { added := await …; if(added, { s := await …; println(s) }); \`…\` })` | the `if` body runs, `out == ""` |
| `fetched := if(added, { s := await …; \`x:${s}\` }, "n");` after a bound await in an arm | the `if`, its await and every later statement of the arm vanish |

## Root cause

Three gaps in the resume side (`src/codegen/async/state_machine.yo`):

1. `_chain_additional_remaining` parks an arm's statements after its SECOND
   await in a new `AsyncCondBranchInfo` at the next await index with
   `cond_branch_field_index = <outer field>` and **no target**. The
   continuation of that state then ran the remaining code with
   `cbd.target_assignment_code == None`, so the tail value was computed into a
   temp and dropped; the outer cond's target (registered on the entry at the
   outer field's index) was never consulted.
2. `_emit_outer_chained_branch_layers` passed a hard-coded `Option(String).None`
   target for the outer arm's chained remaining.
3. `generate_remaining_expr_future` took the `x := …` path for
   `fetched := if(cond, { … await … }, …)`, found the RHS was not an
   `io.await`, and returned — emitting nothing for the binding, the nested
   cond, or its future store; the arm's later statements were then keyed on a
   state that was never entered.

## Fix

- `_cond_layer_target(cbd, cond_field, context)`: the entry's own target, else
  the target of the entry at `cond_field` (the outer cond). Used by the
  main continuation switch, the uniform tail-await handover, the
  dispatch-mode extraction, and the nested-arm continuation; the outer chained
  layers look the outer entry up by the layer's field.
- `generate_remaining_expr_future`: a bound RHS that is not an `io.await`
  delegates to `generate_await_expression`, which already emits
  `x := cond/match(…)` with the binding as the target.
- `_nested_level_target(branch, ninfo, enclosing_target)`: a nested instance
  without its own `x :=` target that is the enclosing arm's TAIL hands its
  value to the enclosing level's target (the bare
  `true => cond(… await …)` arm shape).

**Gate:** `tests/async_await.test.yo` — "a value-producing cond arm that awaits
twice keeps its tail value", "an awaiting if statement after a bound await,
then the arm's tail value", "the yo install shape: …" (the bound `fetched :=
if(…)` form), and the pre-existing "nested cond arms await two DIFFERENT async
fns". The first three fail on the pre-fix compiler.
