# `yo fix --migrate explicit-copy` clones a copy out of a temporary that dies right after it

**Severity:** S3. The migration writes `.clone()` calls nothing needs: a value taken out of a temporary that dies after the copy is usually a move, so each such insertion is a wasted deep copy (no change in what the program computes). One shape also gets a misleading listing: a returned field of a temporary is described as "returned from a borrowed binding", with a projection (`-> &T`) suggested, which would borrow the dying temporary.

**Status:** fixed on `feat/explicit-copy-guards` (plans/VALUES_BY_DEFAULT.md B1, "Path to a landable B1"). Tier 1 run 2026-10-20 on the branch rebased onto develop 7def2203b; results under "Gates" below.

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

A dereference ends the field walk with "not dying": `grab(&s).*.name`
reads the pointee of the dying `Rc` handle, which `s.h` still owns, so it is
a genuine copy and is cloned
(`issues/fixed/2026-10-21-explicit-copy-dying-temporary-guard-calls-a-copy-through-a-dereference-a-move.md`,
found by the branch's review).

Not covered:

- An index of a temporary (`make().tags(usize(0))`) is not a `.` chain, so
  it is still classified by the old rules
  (`issues/2026-10-20-explicit-copy-return-split-calls-a-temporary-a-borrowed-binding.md`).
- A temp-rooted `match` binding is judged by its root alone, with no
  liveness: every copy of it is listed, including one made while the binding
  is still read later in its arm (`hs.push(z); hs.push(z); z`), where a
  `.clone()` is the right edit
  (`issues/2026-10-21-explicit-copy-dying-temporary-guard-lists-every-copy-of-a-reused-match-binding.md`).

## Test

`tests/cli-cases/fix-migrate-explicit-copy-dying-temp`: the five sites above
are listed, and `d := h.name` (a field of a live local) and
`e := grab(&s).*.name` (a field through a dereference) are rewritten.
Before the fix the same fixture got five insertions (four of them out of a dying temporary) and one misleading listing.

## Gates

Run 2026-10-20 on the branch rebased onto develop 7def2203b, with the tree
binary (`yo build --std-path ./std --cc clang`, rc 0) on the 64 GB Linux box:

- `check ./src --std-path ./std`: 278/278 files, rc 0 (6:44 wall, 1,131,364 KB
  max RSS under a shared heavy-lock slot, not a timing). `check ./std --std-path ./std`: 172/172, rc 0.
- `scripts/cli-diff-test.sh` over the five explicit-copy cases: 5 PASS,
  0 GOLDEN-DIFF. The three existing cases (`fix-migrate-explicit-copy`,
  `-arm-tail`, `-generic`) are byte-identical to their goldens; the two new
  cases' hand-computed goldens matched the run as written, so nothing was
  re-recorded. The v0.2.66 seed on the dying-temp fixture (`--dry-run`) gives the
  "before" in the Symptom: five insertions, `make().name` at 14:32 listed as a
  borrowed binding.
- `--hot-path` probes: `hot`, `./hot`, an absolute path and the file itself
  all guard `hot/engine.yo` and leave a sibling `hotter/engine.yo` rewritten
  (segment-wise); a missing path, a non-`explicit-copy` migration and a
  missing argument are each rejected.
- `tests/internal` files importing a changed module: `binding.test.yo` 7/7,
  `evaluator_utils_is_valid_variable_name.test.yo` 6/6. `compile.test.yo`
  fails 4/4 on LeakSanitizer verdicts. These are the pre-existing failures
  in `issues/2026-10-18-four-compile-test-cases-fail-the-local-leak-verdict-on-develop.md`:
  the probe and PATH-helper windows leak exactly that doc's develop numbers
  (22,669 B in 340 allocations; 120 B in 4). The two emit windows leak
  58,993 B / 874 and 59,121 B / 876, against the doc's 59,057 / 875 and 59,569 / 883.
  The leaked classes are the same: 64-byte `Token` cells and 40-byte
  `String`s. The comparison is against that doc's numbers (develop
  5425cd7bf), not a same-day develop run: the borrowed binary meant as the
  baseline did not compile develop's own `src/version.yo`, so it was not a
  develop build. The four tests' assertions got no verdict of their own
  under CI's `YO_TEST_LEAK_VERDICT=0` setting in this run. The changed evaluator code runs only under
  `g_audit_implicit_copy || migrate_explicit_copy_on()`, and the `src/main.yo`
  change only under `yo fix`, so these tests cannot reach either.
- Tree-binary `yo fmt --check` on every changed `.yo`/`.md` file and
  `scripts/check-issue-refs.sh`: clean.
