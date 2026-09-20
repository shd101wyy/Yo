# The cond-arm initialization merge check (E0903) never fires

**Status: open** (found 2026-09-20 while verifying the diagnostics registry's
examples). Repro: `issues/repros/cond-arm-init-not-all-arms.yo`.

## Symptom

```rust
main :: (fn(c : bool) -> unit)({
  (v : i32);
  cond(c => {
    v = i32(1);
  }, true => {
    ();
  });
  _y := v;
});
```

`yo check` passes. Only the first arm initialises `v`, yet the read after the
`cond` is accepted. The same holds with `if(c, { v = i32(1); })`, with two
arms that both assign (correctly accepted), and with the read inside an
expression. Reading `v` with NO assignment anywhere is rejected
(`Variable "v" is not initialized`, now E0404), so the declaration IS tracked
as uninitialised — the per-arm merge is what does not see the assignment.

## Where

`merge_and_check_envs` (`src/evaluator/utils.yo`, the "Case 3: some init,
some don't" branch producing `might be initialized in some cases but not
initialized in other cases`) is called from `cond.yo` and `match.yo` with the
arm bodies. The registry's E0903 entry and the classifier rule describe
exactly this check; the example in the registry is marked as not firing until
this is fixed, and `tests/internal/diagnostics_registry_examples.test.yo`
exempts E0903's `bad` half with a pointer here.

## Fix direction

Instrument the merge: print `initialized_at_tokens` per arm for the repro.
Likely suspects: the assignment `v = …` updates the BASE frame's variable
(`assignment.yo:1241` builds an updated variable) rather than the arm's
case-env copy, so every arm reports it initialised; or the arms' envs are
filtered before the merge. Gate: a check-level cli-case over the repro that
expects E0903, red before, green after — and the registry test's exemption
removed in the same PR.

## Mechanism (from reading, 2026-09-20 — not yet instrumented)
`merge_and_check_envs` (src/evaluator/utils.yo) compares, per outer frame and
per variable, `case_var.initialized_at_token` across the arm envs recorded in
each arm body's `ExprInfo.env`. An assignment `v = …` goes through
`update_existing_variable(env, updated_variable, new_variable)`
(src/evaluator/exprs/assignment.yo ~1262), which replaces the Variable IN THE
FRAME the assignment sees. The arm evaluates under a per-arm `push_frame`, but
the OUTER frames — where `(v : i32)` lives — are the same `ref` Frame objects
in the outer env and in every arm's recorded env. So the first arm's `v = 1`
rewrites the shared frame entry; when the merge runs, the base var AND the
second arm's view both read initialized_at_token = Some → `all_init`, and the
"some init, some don't" branch (E0903) can never be reached for a variable
declared in an outer frame. Only a variable introduced INSIDE the arm frame
could differ per arm — which is not the E0903 shape.

Fix direction: the merge needs per-arm VIEWS of the outer variables' init
state — either snapshot the outer frames' `initialized_at_token` per variable
at arm entry and diff against the value at arm exit (cheap: a parallel array
of Option(Token) per outer variable, taken in cond.yo/match.yo around each arm
eval), or make `update_existing_variable` record "initialized in arm k" in a
side table the merge reads. The snapshot approach touches cond.yo, match.yo
and utils.yo only. Gate: `issues/repros/cond-arm-init-not-all-arms.yo` → E0903;
canaries: both arms assign (accepted), assignment before the cond (accepted),
`if` with an else that assigns (accepted).
