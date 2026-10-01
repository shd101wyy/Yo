# A guarded obligation was owed without its guard: `a ==> b`, and later invariant conjuncts

**Severity:** S2 — valid specs were refuted. An index read in the consequent of
`==>`, or in a loop invariant conjunct that relies on an earlier one, got an
`index-in-bounds` obligation that its own guard was not allowed to discharge.

**Status:** FIXED 2026-10-01 (`feat/verifier-lemmas`).

## Symptom (measured, `dml_sorted_insert`)

- **The `==>` case.** In `invariant(..., (at < xs.len()) ==> (x <= xs(at)))`,
  the `index-in-bounds` obligation for `xs(at)` was REFUTED: it was owed without
  `at < xs.len()`.
- **The later-conjunct case.** In
  `invariant(at <= i, out.len() == (i + usize(1)), out(at) == x, ...)`, the
  bound for `out(at)` was REFUTED. The earlier conjuncts were not on the path
  while it was walked.

## Cause

- **`==>`** walked its consequent under the bare path. `&&` and `||` already
  bracket their right side with their left; `==>` did not.
- **Invariants.** `_while_term` walked every invariant conjunct under the same
  path, at entry, at the havoc, at iterate and at exit.

## Fix

- **`==>`** pushes its antecedent while its consequent is walked, then restores
  the path.
- **Invariants.** `_walk_invariants_in_order` walks the conjuncts in order, with
  each earlier one on the path while the next is walked (Dafny's well-formedness
  rule). That is sound for goals as well: a later conjunct's read only matters
  where the earlier ones hold, and if an earlier one fails the goal fails anyway.

## Regression test

`tests/spec/fixtures/valid/dml_sorted_insert.yo`, registered in
`tests/internal/verifier_list_len.test.yo`. Its invariants contain both shapes.
