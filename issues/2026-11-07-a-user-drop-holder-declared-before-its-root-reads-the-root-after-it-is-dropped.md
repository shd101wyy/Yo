# A user-`Drop` holder in a slot declared before its root reads the root in `drop` after the root's drop

**Severity:** S1 — use-after-free inside a user `Drop` impl in safe code

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-user-drop-holder-declared-before-its-root-reads-the-root-after-it-is-dropped.yo`.

`yo check` accepts it ("evaluator OK", tree binary at develop `8d475cd81` and later); compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free` inside `drop`.

## Root cause

The holder's live range ends at its last use, not at its scope-end drop, for a type that reaches a user `Drop` (`REFERENCES_AND_ORIGINS.md` O3, "Drops that use no root", is unbuilt), so reverse-declaration drop order frees the root first.

## Fix

O-4 (`Drop`-extended liveness), v0.2.77 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

corpus row `drop-holder-before-root`; the repro under `tests/origins/unsound/`.
