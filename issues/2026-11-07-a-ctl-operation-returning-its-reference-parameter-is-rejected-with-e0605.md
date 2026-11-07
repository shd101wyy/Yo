# A `ctl` operation returning its reference parameter (`ctl(key : &i32) -> &(i32, key)` resumed with `return(key)`) is rejected with E0605

**Severity:** S2 — a valid program is rejected (`Expected type "*(i32)", but got "i32"`)

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-ctl-operation-returning-its-reference-parameter-is-rejected-with-e0605.yo`.

`yo check` reports `error[E0605]: Return type mismatch. Expected type "*(i32)", but got "i32".` Corpus row `effect-resume-param`.

## Root cause

`ctl` signatures keep the pre-decision-43 pointer result form; N1b's retype never reached `ctl`.

## Fix

P8, v0.2.77 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

corpus row `effect-resume-param` goes green; `tests/algebraic_effects.test.yo` gains the case.
