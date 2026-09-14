# A sibling arm's second-await binding is never assigned when its continuation lands in a chained layer

**Status:** FIXED 2026-09-11 (`fix/async-nested-match-dead-arm`).
**Found:** 2026-09-11, running `yo install shd101wyy/raylib_yo@v0.0.6` with a
gen-2 compiler carrying the nested-dispatch fix: `deps.yo` gained the right
line but `if(added, { … fetch … })` never ran — `run_install`'s `.Git` arm
read its `added` as `false`. The emitted state machine confirmed the slot for
that `added` is written nowhere. Reproduces on the pre-fix compiler with two
plain sibling arms (no nesting).
**Severity:** high — silent wrong control flow, `check` clean.

## Reproducer

`issues/repros/async-chained-sibling-arm-second-await-binding-never-assigned.yo`:

```rust
match(
  k,
  .A => {
    exists := e.io.await(flag(e.io), e);
    added := e.io.await(flag(e.io), e);   // second await
    if(added, { log.push_str("A:added;"); });
  },
  .B => {
    nm := e.io.await(name_of(e.io), e);
    added := e.io.await(flag(e.io), e);   // second await, same type
    if(added, { log.push_str("B:added;"); });   // never ran
  }
);
```

## Root cause

Both arms' second awaits share one await point (uniform mode — same future
type). The first arm to chain creates that point's entry
(`_chain_additional_remaining`, `.None` path) and its record lives in
`branches`, where the main continuation switch assigns the arm's own binding
(`sm->var_<added> = sm->await_result_N`, the per-branch `await_target_variable_id`
logic). The second arm to chain is appended as a chained LAYER
(`chained_branches`), and both layer emitters —
`_emit_outer_chained_branch_layers` and the same-field layer block in
`_emit_cond_branch_continuation` — ran the layer's remaining code WITHOUT that
assignment. The dispatch-mode path had been fixed earlier
(issues/fixed/async-cond-dispatch-skips-chained-sibling-arm.md); the uniform
path had not.

## Fix

`_emit_chained_arm_binding` (`src/codegen/async/state_machine.yo`) emits the
binding for a chained arm under the same three conditions the main switch
applies (not the arm the pre-switch copy covers, the binding lives in the
state struct, it has this point's result type), before the layer's remaining
code, in both layer emitters. Dispatch-mode points are untouched (their
extraction assigns per arm).

**Gate:** `tests/async_await.test.yo` — "a sibling arm's second-await binding
is assigned when its continuation is a chained layer"; and `yo install
user/repo@tag` end to end with a gen-2 compiler now prints `Fetching
dependency...` and writes `yo.lock`.
