# A holder returned over a borrowed temporary is accepted when bound, and is a use-after-free since the temporary drops at its statement's end

**Severity:** S1: a use-after-free in safe code. Filed as latent; the statement-end drop fix (`issues/fixed/2026-11-06-a-borrowed-temporary-is-dropped-at-its-blocks-end-not-its-statements.md`) landed before O-5, so the accepted program now frees the temporary while the bound holder still points into it

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-holder-returned-over-a-borrowed-temporary-is-accepted-when-bound.yo`.

`yo check` accepts it. When filed it ran clean (`OUT: 72 74`) because the temporary lived to the block's end. Measured 2026-11-08 on the v0.2.76 seed: compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free` at the `println`, because `mk_x()`'s temporary is now dropped at the end of `h := mk(&mk_x());`. The projection form (`p58b_ref_from_temporary_call.yo`) is already rejected.

## Root cause

The temporary rejection exists for projections only; a holder result names the hidden temporary place and `bind` does not see it.

## Fix

O-5 (R-TEMP), v0.2.77 — the statement-end drop fix may not merge before it (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

corpus row `holder-from-temporary`; the repro under `tests/origins/unsound/` must stay rejected.

## Resolution (O-5, 2026-11-08)

R-TEMP (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §3) in `src/evaluator/utils.yo`: a temporary lent to a
reference parameter (a call's argument or a method call's receiver; `is_temporary_operand` reads the operand
structurally, since `local_borrow_place_of` reads a call as its callee's place) is a hidden statement local, an
`origin_of` entry `#temporary`. `bind` (`:=`), the `=` join and `return_check` reject a value whose origin names one
(E0911: the temporary's statement-end drop while the holder lives; E0912 for a return). The projection binding
(`r := c.borrow().get()`) rejects a temporary at a reference parameter even when it is a holder, whose roots it had
read through before (VERDICTS-36's `guard3`: the guard's `drop` released a RefCell borrow while `r` lived).

Tests: `tests/origins/unsound/l1-holder-from-temporary*.yo` (this program; ASan heap-use-after-free on develop) and
`guard3-projection-off-temporary-guard*.yo`, corpus rows `lend-of-temporary-in-call-result` and
`holder-from-temporary` with their model verdicts.
