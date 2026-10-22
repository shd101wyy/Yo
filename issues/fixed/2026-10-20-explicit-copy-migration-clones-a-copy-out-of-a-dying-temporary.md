# `yo fix --migrate explicit-copy` clones a copy out of a temporary that dies right after it

**Severity:** S3. The migration writes `.clone()` calls nothing needs: a value taken out of a temporary that dies after the copy is usually a move, so each such insertion is a wasted deep copy (no change in what the program computes). One shape also gets a misleading listing: a returned field of a temporary is described as "returned from a borrowed binding", with a projection (`-> &T`) suggested, which would borrow the dying temporary.

**Status:** fixed on `feat/explicit-copy-guards` (plans/VALUES_BY_DEFAULT.md B1, "Path to a landable B1"). Tier 1 run 2026-10-20 on the branch rebased onto develop 7def2203b, re-run 2026-10-21 after the review fixes; results under "Gates" below.

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
  (`issues/fixed/2026-10-20-explicit-copy-return-split-calls-a-temporary-a-borrowed-binding.md`,
  fixed 2026-10-22).
- A temp-rooted `match` binding is judged by its root alone, with no
  liveness: every copy of it is listed, including one made while the binding
  is still read later in its arm (`hs.push(z); hs.push(z); z`), where a
  `.clone()` is the right edit
  (`issues/fixed/2026-10-21-explicit-copy-dying-temporary-guard-lists-every-copy-of-a-reused-match-binding.md`,
  fixed 2026-10-22).

## Test

`tests/cli-cases/fix-migrate-explicit-copy-dying-temp`: the five sites above
are listed, and `d := h.name` (a field of a live local) and
`e := grab(&s).*.name` (a field through a dereference) are rewritten.
Before the fix the same fixture got five insertions (four of them out of a dying temporary) and one misleading listing.

## Gates

Final run 2026-10-21 at `399d4fa6c` (the branch rebased onto develop
7def2203b plus the review fixes: the dereference stop, the comment and doc
corrections, the re-recorded dying-temp goldens), with the tree binary
(`yo build --std-path ./std --cc clang`, rc 0; one pre-existing unused-variable
warning in `src/evaluator/types/function.yo`) on the 64 GB Linux box, each
step under one shared heavy-lock slot (no number below is a timing):

- `check ./src --std-path ./std`: 278/278 files, rc 0 (5:28 wall, 1,142,152 KB
  max RSS). `check ./std --std-path ./std`: 172/172, rc 0.
- `scripts/cli-diff-test.sh` over the five explicit-copy cases: 5 PASS,
  0 GOLDEN-DIFF. The three older cases (`fix-migrate-explicit-copy`,
  `-arm-tail`, `-generic`) are byte-identical to their goldens. The
  dying-temp case was re-recorded once, after reading its GOLDEN-DIFF: the
  added `e := grab(&s).*.name` line moved the summary from "inserted 1" to
  "inserted 2" and the tree hash to `5039e25d...`, which equals the sha256 of
  the hand-computed rewrite (the fixture with `.clone()` appended at 23:8 and
  28:8). The hot-path golden was not touched. The v0.2.66 seed on the
  dying-temp fixture (`--dry-run`, 2026-10-20) gave the "before" in the
  Symptom: five insertions, `make().name` at 14:32 listed as a borrowed
  binding.
- `--hot-path` probes (2026-10-20): `hot`, `./hot`, an absolute path and the
  file itself all guard `hot/engine.yo` and leave a sibling
  `hotter/engine.yo` rewritten (segment-wise); a missing path, a
  non-`explicit-copy` migration and a missing argument are each rejected.
- `tests/internal` files importing a changed module, one per call with
  `--parallel 1`: `binding.test.yo` 7/7, `evaluator_utils_is_valid_variable_name.test.yo`
  6/6, and `compile.test.yo` 4/4 under `YO_TEST_LEAK_VERDICT=0` (CI's
  setting; 21:52 wall, 2,982,020 KB). With the leak verdict on (the
  2026-10-20 run) the same four fail on LeakSanitizer reports only: the
  pre-existing failures in
  `issues/2026-10-18-four-compile-test-cases-fail-the-local-leak-verdict-on-develop.md`
  (probe and PATH-helper windows exactly that doc's develop numbers, 22,669 B
  in 340 allocations and 120 B in 4; the emit windows 58,993 B / 874 and
  59,121 B / 876 against 59,057 / 875 and 59,569 / 883; the same `Token`
  and `String` classes). That comparison is against the doc's develop
  5425cd7bf numbers, not a same-day develop run.
- Tree-binary `yo fmt --check` on every changed `.yo`/`.md` file and
  `scripts/check-issue-refs.sh`: clean.
