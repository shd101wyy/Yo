# Two cli-cases fail on develop after the loan-table unification (#1932)

**Severity:** S2 — `tests/cli-cases/audit-inout-borrow-lists-collection-writes` and `tests/cli-cases/check-test-bodies-auto-boxed-dyn` fail with rc=1 on the develop tip where their goldens expect rc=0, so every lane's cli-diff gate (and develop's own battery, if it runs cli-diff) reports GOLDEN-DIFFs unrelated to whatever that lane changed.

Filed 2026-11-14 by the d49-str lane while gating `fix/str-static-views` (a std-only PR that touches none of this). Both cases fail IDENTICALLY on the pure develop worktree at `57fb978f9` with its own develop-built binary — measured by running each case alone (`bash scripts/cli-diff-test.sh <case>`), not only inside a battery.

**Status:** fixed 2026-11-14 on `fix/develop-1932-cli-goldens` (see "Fix" below): both rejections are #1932's intended semantics, so the FIXTURES migrate to the post-c2 spelling and the goldens re-record; no evaluator change was needed. The same fallout reached two codegen-corpus fixtures (`tests/codegen-bootstrap/closure_param_capture.yo` and `dyn_box_closure_binding.yo`, GOLDEN-DIFF compile_rc=1 where the goldens expect 0); they are fixed the same way on `fix/develop-codegen-corpus-fixtures` — see "Fix, part two".

## Evidence

- `audit-inout-borrow-lists-collection-writes` (`check main.yo` on its fixture): the fixture now fails with

  ```text
  error[E0908]: Cannot pass `out` as the `self : &mut Self` receiver: `out` is a `&T` parameter, which borrows its value, and holds data (ArrayList(i32)) that its owner still holds. ...
  ```

  The golden expects rc=0 ("evaluator OK" output shape). The text is #1932's new `access(place, mode)` judgement (a `&` parameter passed on to a `&mut` slot is a write into the borrowed copy). [Measured bare, without the case's `YO_AUDIT_INOUT_BORROW=1`; under that env — the way the case runs — the `out`/`d` writes are LISTED, not raised, and the rc=1 comes from E0913 at the fixture's capture write (`seen.push(i32(9))` in an `Fn` closure at an `&Impl(Fn)` slot). — fixdev-1932 lane, 2026-11-14.]
- `check-test-bodies-auto-boxed-dyn`: same rc flip, with #1932's E0913 ("Cannot assign to `x` here: the closure captures it implicitly, by value, and its call borrows the captures shared ... The write would change the closure's copy and release storage `x` still owns.").

## Root cause

#1932 (a76974e41, "one access(place, mode) for every loan table") landed without re-recording these two goldens (or over-rejects exactly the shapes the fixtures pin: a by-value parameter passed on to a `&mut` receiver, and an implicit by-value capture written through an `Fn` closure). Which of the two it is — intended behavior change needing `--record`, or an over-rejection needing a fix — belongs to the #1932 lane / the develop fix-forward flow.

## Fix (fix/develop-1932-cli-goldens, 2026-11-14)

Both rejections are the intended #1932 semantics (the same shapes `tests/closure.test.yo` and `tests/rc.test.yo` were retyped for in #1936), so the fixtures migrate and the goldens re-record:

- `audit-inout-borrow-lists-collection-writes`: the closure writing its implicit capture moves from `apply(() => { seen.push(...) })` (an `Fn` slot) to an owning `(mut(bump) : Impl(FnMut() -> unit)) = (() => { seen.push(...) }); bump();` binding. The audit still lists all three rows — the capture row keeps its `[inout-borrow-capture]` tag and "a captured variable" noun because the capture stays IMPLICIT (a `{ seen }` capture-list entry is listed under the plain `[inout-borrow]` tag with a wrong noun, filed separately as `issues/2026-11-14-the-inout-borrow-audit-labels-a-by-value-capture-list-entry-a-match-or-for-binding.md`); only its line number moves (40:5 → 43:7).
- `check-test-bodies-auto-boxed-dyn`: the auto-boxed closure retypes `Dyn(Fn(...))` → `Dyn(FnMut(...))` with a `mut` binding (an `Fn` closure may not write an implicit capture; a `Dyn(FnMut)` call borrows the closure exclusively). `evaluator OK` stdout is unchanged; only the fixture hash re-records.

## Fix, part two (fix/develop-codegen-corpus-fixtures, 2026-11-14)

The codegen corpus (gates_fast GATE 2, `scripts/diff-test.sh tests/codegen-bootstrap`) carried the same two shapes and went GOLDEN-DIFF on the #1936 tip; #1944's cli-case heal did not cover them. Same treatment, fixtures only — and here the goldens did NOT re-record, because diff-test scores run behavior and both programs' stdout and exit codes are unchanged (`21` and `ok`, `compile_rc=0 rc=0`):

- `closure_param_capture.yo`: the dyn closure writes its implicit `extras` capture, so `Detector.detect` retypes `Dyn(Fn(...))` → `Dyn(FnMut(...))` (an exclusive-borrow call), `run_detector` takes `&mut Detector`, and the binding becomes `mut(d)`/`&mut d`. Everything the fixture pins — the dyn closure capturing a local HashMap AND the enclosing `Impl(Fn)` param, the capture-struct field ordering, the dyn-box specialization — is preserved.
- `dyn_box_closure_binding.yo`: the `Rc(Dyn(Fn(...)))` two-handle shape STAYS (it is the fixture's codegen subject); the closure's counter moves behind an `Rc(RefCell(i32))` the closure captures shared — a write through a `RefCell` door is a read of the handle, not a capture write, so no E0913. `Rc.clone`, both `.*(n)` call sites and the arithmetic are unchanged; the now-meaningless `assert(x == 1, ...)` (the state is shared by design) is dropped.
