# `yo fix --migrate explicit-copy` clones a copy out of a temporary that dies right after it

**Severity:** S3. The migration writes `.clone()` calls nothing needs: a value taken out of a temporary that dies after the copy is a move, so each insertion is a wasted deep copy (no change in what the program computes). One shape also gets a misleading listing: a returned field of a temporary is described as "returned from a borrowed binding", with a projection (`-> &T`) suggested, which would borrow the dying temporary.

**Status:** fixed on `feat/explicit-copy-guards` (plans/VALUES_BY_DEFAULT.md B1, "Path to a landable B1"). The fix has been checked only with single-file probes: the Tier 1 gates (build, `check ./src`, the cli cases) run after the v0.2.67 cut.

> Found 2026-10-19 by the `b1diag` investigation of the parked B1 sweep
> (`issues/retired/2026-10-19-did-the-explicit-copy-migration-misread-moves-as-copies-on-env-carrying-sites.md`,
> "Tool gaps"). It is real but secondary: fixing it does not recover the
> sweep's ~80x regression.

## Symptom

A probe with the v0.2.66 tree (`yo fix probe.yo --migrate explicit-copy --dry-run`):

```yo ignore
first_name :: (fn() -> String)(make().name);          // listed: "returned from a borrowed binding"
a := make().name;                                     // binding: `(make().name)` would become `make().name.clone()`
b := match(make_opt(), .Some(z) => z, .None => ...);  // return: `z` would become `z.clone()`
c := match(m.get(k), .Some(v) => v, .None => ...);    // return: `v` would become `v.clone()`
n := hold(match(make_opt(), .Some(w) => w, .None => ...));  // return: `w` would become `w.clone()`
```

Each source is part of a call's result, which dies at the end of the
statement. The evaluator already treats a `match` binding of such a temporary
as a move: `.Some(y) => { k := hold(y); k + y.len() }` is E0901 at `y.len()`.

## Root cause

The migration takes its sites from the explicit-copy audit
(`audit_record_implicit_copy`, `src/evaluator/utils.yo`). That audit reports a
`match` binding of a temporary (`source=temp-payload`) and a field read
(`source=projection`) at once, as copies: today's RC dup at those sites is
real, so the audit is right for its own purpose. The copy-trait audit
(`audit_record_copy_trait`) does apply the temporary-as-move rule (its
`r.kind == "temp"` arm returns without a report), but the migration never
consulted it. The return split's root walker (`_ic_place_root_var`) follows a
call's callee, so for `make().name` it resolves the function binding `make`
and calls it a borrowed binding.

## Fix

`set_expr_as_needs_to_call_dup` computes `ICMigrateCtx.src_dying`
(`_ic_dying_temp_source`): a `match` binding whose root is `temp`, classified
as the audit classifies `temp-payload`, or a `.` field read whose receiver
chain, read through the ExprInfo table, ends in an owning temporary. The
driver (`_run_migrate_explicit_copy`, `src/main.yo`) checks this first and
lists the site ("... a temporary that dies after the copy, so the copy is
usually a move; left as written"). The audit's own output is unchanged.

Not covered: an index of a temporary (`make().tags(usize(0))`) is not a `.`
chain, so it is still classified by the old rules
(`issues/2026-10-20-explicit-copy-return-split-calls-a-temporary-a-borrowed-binding.md`).

## Test

`tests/cli-cases/fix-migrate-explicit-copy-dying-temp`: the five sites above
are listed and only `d := h.name` (a field of a live local) is rewritten.
Before the fix the same fixture got five insertions (four of them out of a dying temporary) and one misleading listing.
