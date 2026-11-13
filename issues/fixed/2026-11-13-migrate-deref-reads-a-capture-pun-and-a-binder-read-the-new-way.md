# `yo fix --migrate deref` reads a capture-list entry and an unbound-binder argument of a reference binding the new way

**Severity:** S2 — the migration of source written before the deref rule either stops (a
file with a capture-list entry `{ r }` of a reference binding that flows into a `sink`
parameter "does not evaluate", and every file importing it fails too) or silently changes
meaning (a bare `r` passed to an unbound type binder binds `T := &U` instead of `T := U`
and is left as written).

Filed 2026-11-13 by the `sweep` lane while regenerating N3's deref Generation B: the sweep
`yo fix std src scripts build.yo --migrate deref`, run with the local deletion binary on
develop `6c90536aa`, reported 104 `src/` files as not evaluating. `YO_AUDIT_DEREF=1 yo check
src/build_runner.yo` named the first one: `src/expr_info.yo`'s `record_flow_event` captures
its `&Option(Token)` parameters with `g_branch_init_log.with_mut({ after_consumed, … }(xs) =>
…)`, and the capture became a borrow (E0909 into `with_mut`'s `sink` callback).

## Reproducer

```yo ignore
keep :: (fn(sink(f) : Impl(Fn() -> i32)) -> i32)(f());
first :: (fn(generic(T : Type), v : T) -> T)(v);
show :: (fn(r : &i32) -> i32)({
  n := keep({ r }() => r);
  m := first(r);
  (n + m)
});
```

Source written before the rule meant `{ r }` to copy the referent and `first(r)` to bind
`T := i32`. `yo fix --migrate deref` should write `{ r : r.* }` and `first(r.*)`.

## Root cause

Two read rules landed after the recorder was written and did not consult it:

- VERDICTS-44 R-CAP-1 (#1891): a by-value capture-list entry whose initializer is a
  reference binding copies the reference (`_evaluate_capture_list`,
  `src/evaluator/values/anonymous_function.yo`). In the recording mode the entry took that
  branch too, so no E0926 was recorded and the closure borrowed.
- R1 (#1805): a reference binding read at an unbound type binder is the reference
  (`reference_read_wanted`, `src/evaluator/utils.yo`). The recording mode read it as the
  reference as well, so the site was never recorded.

## Fix

While `deref_rule_recording()` holds, both sites evaluate the old way: the capture entry is
a by-value copy of the referent (its initializer's E0926 records the `.*`, and a pun records
its label, edit 1), and the binder read takes the value (its E0926 records the `.*`).

Test: `tests/cli-cases/fix-migrate-deref-capture-and-binder` (the migrated file checks;
before the fix the case fails with E0909 and leaves both sites unmigrated).
