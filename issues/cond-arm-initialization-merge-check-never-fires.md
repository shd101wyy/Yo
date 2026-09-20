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
