# A holder returned over a borrowed temporary is accepted when bound; it is sound only because the temporary drops at the block's end

**Severity:** S1 (latent) — an ordering constraint: fixing `issues/2026-11-06-a-borrowed-temporary-is-dropped-at-its-blocks-end-not-its-statements.md` first turns this accepted program into a use-after-free

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-holder-returned-over-a-borrowed-temporary-is-accepted-when-bound.yo`.

`yo check` accepts it and it runs clean today (`OUT: 72 74`), because the temporary lives to the block's end. The projection form (`p58b_ref_from_temporary_call.yo`) is already rejected.

## Root cause

The temporary rejection exists for projections only; a holder result names the hidden temporary place and `bind` does not see it.

## Fix

O-5 (R-TEMP), v0.2.77 — the statement-end drop fix may not merge before it (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

corpus row `holder-from-temporary`; the repro under `tests/origins/unsound/` must stay rejected.
