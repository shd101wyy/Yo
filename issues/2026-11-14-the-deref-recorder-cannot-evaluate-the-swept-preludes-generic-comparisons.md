# The deref recorder cannot evaluate the swept prelude's generic comparisons: `yo fix --migrate deref` fails on every judged file against the Generation B std

**Severity:** S2 — the shipped `--migrate deref` command stops ("does not evaluate") for EVERY judged file whose evaluation loads the swept prelude, under the v0.2.77 seed and the v0.2.78 stage 1 alike. A loud failure, never a wrong binary; but merging the text sweep without the rider makes `yo fix --migrate deref` unusable and turns the five `tests/cli-cases/fix-migrate-deref-*` goldens red.

## What happened

The v0.2.78 deref text sweep (VERDICTS-60) rewrites, among ~6,300 sites, the payload
comparisons inside the prelude's generic `Eq`/`Ord` impls. `Eq(Option(T))`'s `(==)`,
where `lhs : &Option(T)` matches through the reference and `a`/`b` are lent `&T` match
bindings:

```yo
// develop
.Some(b) => (a == b)
// swept (correct Generation B: compare the referents)
.Some(b) => (a.* == b.*)
```

`yo check` accepts the swept line (all gates green: seed check/build, stage-1
check/build, compile, fixpoint, 433/441 cli cases). But `yo fix --migrate deref`
evaluates the target — and its imports, starting with the prelude — in the RECORDER
mode, and there the swept operand breaks evaluation:

```text
$ yo fix <dir> --migrate deref --std-path <swept std>
fix: main.yo does not evaluate; its references are migrated only as far as evaluation reached
fix: applied 0 edit(s); 1 file(s) did not evaluate

$ YO_AUDIT_DEREF=1 yo check clean.yo --std-path <swept std>
error[E0601]: Incompatible type with expected type:
- Expected: bool
- Actual  : unit
     --> std/prelude.yo:9459:30
9459 |             .Some(b) => (a.* == b.*)
```

## Reproducer

1. Any judged file (even one already in the new spelling, no rewrite needed):
   `{ println } :: import("std/fmt"); peek :: (fn(n : &i32) -> i32)(n.*); main ... export(main);`
2. `yo fix <dir> --migrate deref --std-path ./std` with the swept `./std` → rc 1, "does not evaluate".
3. The same command with develop's `./std` → rc 0, "0 file(s) did not evaluate".

Fails identically with the installed seed v0.2.77, the text-sweep stage 1 (`bin/yo-dt1`),
and the deletion binary `yo-del2` (which already carries the `fc80e38da` recorder fix for
capture puns and binder reads, commit `c6d1ba80e` on `vbd/deref-genb`) — so this is a
THIRD recorder gap, not the known two.

## Root cause

The recorder reads source the OLD way while it records the `.*` edits. At an operator
operand whose binding is a lent `&T` MATCH binding inside a generic impl (`a.*` in
`Eq(Option(T))`'s `(==)`), that old-way reading of the WRITTEN `.*` does not
type-check (the operand resolves to unit where the `==` impl expects the payload
type), so the prelude's evaluation fails before any site is recorded. Evaluation stops
at the first such site; the swept prelude contains the whole class (the generic
`Eq`/`Ord` comparisons), and every judged file imports the prelude.

The swept text itself is the correct Generation B spelling — the fix belongs in the
recorder (`src/evaluator/`'s recording-mode reading of a written `.*` at an operator
operand over a lent match binding), not in the sweep.

## Fix

The rider PR (VERDICTS-60 decisions 11–14: "a third seed gap found there is a rider
that merges before the Nov 23 20:00 freeze"). Until it lands, the five
`tests/cli-cases/fix-migrate-deref-*` goldens fail against the swept std — they are
this issue's failing tests (they pass with develop's std). The rider must also carry
fc80e38da's two hunks (or their equivalents), which the text PR leaves out per
VERDICTS-60 decision 15.1.

Found by the full `scripts/cli-diff-test.sh` run of the text-sweep stage 1: the five
`fix-migrate-deref-*` cases failed while the same cases pass on the v0.2.78 brace tree
(same develop base, no deref sweep).
