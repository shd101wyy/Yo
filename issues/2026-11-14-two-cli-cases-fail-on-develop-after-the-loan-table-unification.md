# Two cli-cases fail on develop after the loan-table unification (#1932)

**Severity:** S2 — `tests/cli-cases/audit-inout-borrow-lists-collection-writes` and `tests/cli-cases/check-test-bodies-auto-boxed-dyn` fail with rc=1 on the develop tip where their goldens expect rc=0, so every lane's cli-diff gate (and develop's own battery, if it runs cli-diff) reports GOLDEN-DIFFs unrelated to whatever that lane changed.

Filed 2026-11-14 by the d49-str lane while gating `fix/str-static-views` (a std-only PR that touches none of this). Both cases fail IDENTICALLY on the pure develop worktree at `57fb978f9` with its own develop-built binary — measured by running each case alone (`bash scripts/cli-diff-test.sh <case>`), not only inside a battery.

## Evidence

- `audit-inout-borrow-lists-collection-writes` (`check main.yo` on its fixture): the fixture now fails with

  ```text
  error[E0908]: Cannot pass `out` as the `self : &mut Self` receiver: `out` is a `&T` parameter, which borrows its value, and holds data (ArrayList(i32)) that its owner still holds. ...
  ```

  The golden expects rc=0 ("evaluator OK" output shape). The text is #1932's new `access(place, mode)` judgement (a `&` parameter passed on to a `&mut` slot is a write into the borrowed copy).
- `check-test-bodies-auto-boxed-dyn`: same rc flip, with #1932's E0913 ("Cannot assign to `x` here: the closure captures it implicitly, by value, and its call borrows the captures shared ... The write would change the closure's copy and release storage `x` still owns.").

## Root cause

#1932 (a76974e41, "one access(place, mode) for every loan table") landed without re-recording these two goldens (or over-rejects exactly the shapes the fixtures pin: a by-value parameter passed on to a `&mut` receiver, and an implicit by-value capture written through an `Fn` closure). Which of the two it is — intended behavior change needing `--record`, or an over-rejection needing a fix — belongs to the #1932 lane / the develop fix-forward flow.

## Plan

The maintainer's fix-forward rule for develop applies: re-record the goldens if the rejections are the intended #1932 semantics, or fix the over-rejection in the evaluator. Until then, every cli-diff run on develop shows these two GOLDEN-DIFFs; lanes should diff their own cases against this pair before believing a failure.
