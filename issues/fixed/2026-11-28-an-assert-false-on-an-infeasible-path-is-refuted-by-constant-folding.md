# An `assert(false)` on an infeasible path is refuted by constant folding

**Severity:** S2. `yo verify` refutes a correct function. `assert(false)` under a branch that the `requires` rules out is the idiom for "this case cannot happen" (`plans/backlog/SPEC_AND_PROOF.md` §4.3, and the E0930 message for `panic` in a proof). The verifier reports it `REFUTED (folded)` without asking the solver.

**Status:** fixed by PR 1b of `plans/backlog/SPEC_AND_PROOF.md` (§8). **Found:** 2026-11-28 while writing `tests/spec/fixtures/valid/lemma-impossible-case.yo`. Reproduced on v0.2.80 with Z3 5.1.0.

## Reproducer

`issues/repros/2026-11-28-an-assert-false-on-an-infeasible-path-is-refuted-by-constant-folding.yo`:

```yo
pragma(Pragma.Verify);
{ assert } :: import("std/assert");

f :: (fn(x : i32, requires(x > i32(10)), ensures(r > i32(0))) -> (r : i32))({
  cond(
    (x <= i32(0)) => assert(false),
    true => ()
  );
  x
});
```

`yo verify --strict` (v0.2.80) exits 1:

```text
  refuted  fn@issues/repros/2026-11-28-an-assert-false-on-an-infeasible-path-is-refuted-by-constant-folding.yo:3 [verify]
    fn@issues/repros/2026-11-28-an-assert-false-on-an-infeasible-path-is-refuted-by-constant-folding.yo:3/assert: REFUTED (folded)
verify: 0 ok, 0 assumed, 0 outside-subset, 0 unproven, 1 refuted, 0 solver-error, 0 subset-error (0 of the ok vacuous) — 1 queries, 0 cached (0%), 1 folded, 45 ms
```

## Root cause

`_emit` (`src/verifier/vc.yo`) constant-folds each obligation's goal and pre-resolves the verdict when the goal folds to a literal, so the driver skips the solver. A query is "assumptions ⇒ goal". A goal that folds to `true` is proved under any assumptions. A goal that folds to `false` is refuted only when the assumptions can hold, and `_emit` did not look at them. Here they are `x > 10` and `x <= 0`, which contradict each other, so the obligation holds.

## Fix

`_emit` pre-refutes a `false` goal only when every path assumption folds to `true`, or there is none (`_assumptions_fold_true`). Otherwise the query goes to the solver. The literal-argument folds of `tests/spec/fixtures/valid/refine-literal.yo` have no assumptions, so they still pre-resolve: the bogus-solver test in `tests/internal/verifier-refine.test.yo` covers that.

Tests:
- `tests/spec/fixtures/valid/assert-false-infeasible-path.yo`, the reproducer: refuted before the fix, `ok` after.
- `tests/spec/fixtures/valid/lemma-impossible-case.yo`, the lemma form, checked by `tests/internal/verifier-ghost.test.yo`.
