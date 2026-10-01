# A `check --watch` per-definition round re-forces the edited definition but not its same-module callers

**Severity:** S2 — in `check --watch` / `--watch-once` (the only caller of the per-def round, `watch_round` in `src/check_watch.yo`), an edit that breaks a same-module caller's type check, or makes a thread closure reach a non-Send global through a same-module caller, passes the round (`0 failed`, rc 0) while a cold `check` of the same tree rejects it

**Status:** FIXED 2026-10-01 on `fix/check-foreign-bodies` (`_revalidation_closure`, `src/module_manager.yo`).
Reported by the adversarial review of that branch. It was already present before the branch: the
installed seed `yo 0.2.48` accepts the type-check case. Regression test:
`tests/internal/check_watch.test.yo` "Phase 3b: an edit re-judges the edited definition's
same-module callers, transitively".

## Symptom

Type check. `lib.yo`:

```rust
helper :: (fn() -> i32)(i32(1));
answer :: (fn() -> i32)((helper() + i32(41)));
export(answer, helper);
```

`app.yo` calls `lib_mod.answer()`. Run `check app.yo --watch-once`, then edit `helper` to
`(fn() -> bool)(true)` and feed `lib.yo` on stdin. Both `yo 0.2.48` and the pre-fix branch
build print `watch: revalidated 1 definition(s), rechecked 0 file(s), 0 failed`, rc 0. A cold
`check app.yo` on the edited tree fails with `error[E0610]: No matching call found for operator
"+" with receiver type "bool"`.

Rule D1. `lib.yo` holds a non-Send global `g := ArrayList(i32).new()` and a `work` that does not
touch it. `app.yo` defines `helper :: fn() { lib_mod.work(); }`, and `main` spawns a thread whose
closure calls `helper()`. If `work`'s body is edited to `g.push(i32(1));`, the round reports
`per-def revalidated=2 ... failures=0`. A cold `check` reports that the closure calls `helper`, which
calls `lib_mod.work`, which references the non-Send global `g`. The same stale accept happens when the
global, the edited function and the spawning caller all live in one module.

## Root cause

`mm_revalidate_plan` re-forced `def_dependents_closure(seeds)`, which follows the recorded def edges
in `g_def_deps`. Those edges are recorded only by cross-module member reads and by forced lookups
under a non-empty forcing stack (`record_def_dependency`). A module's definitions read each other
through the module frame, so an in-order or forward reference from an in-order root records no
edge. The edited definition's same-module callers were therefore left out of the plan. So were their
own callers and those callers' cross-module dependents. They kept their previous verdicts: the type
check against the old signature, the D1 reach and the StrictBorrow mask.

The re-bind path already scanned for this case (`_defs_mentioning` for a re-bound importer), but
only one level deep and only for importers.

## Fix

`_revalidation_closure(seeds)` closes the recorded def edges under same-module mentions, repeating
until nothing new is added. For every member, `_defs_mentioning` finds the definitions in its module
whose source names it. Their recorded dependents join through `def_dependents_closure`, and the
loop runs until nothing new joins. The plan and the re-bind closure both use it.

Two admissions followed from the wider closure:

- `_defs_mentioning` now returns `impl` statements too. An impl cannot re-force per definition, so
  admitting one sends its module to the file-level path. Before, it was silently left stale.
- A closure module's top-level ordered statements are checked against its revalidated names for the
  changed module as well (the `module != diff.module_key` exclusion is gone). A same-module
  dependent read by `x := mid();` or by a `test(...)` cannot re-run per definition.

Mentions are syntactic and over-approximate (a shadowed local with the same spelling counts).
A false positive only re-forces one extra definition.

## Red before

- The `yo 0.2.48` seed and the pre-fix branch binary (`tmp/B4`, built from `086d9806d`) both
  accept the type-check case above with `0 failed`, rc 0. The cold `check` gives rc 1.
- The new `check_watch` test fails under the pre-fix module manager. Its first per-def round
  reports `failed=0` where `1` is expected.
