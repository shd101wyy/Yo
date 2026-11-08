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
