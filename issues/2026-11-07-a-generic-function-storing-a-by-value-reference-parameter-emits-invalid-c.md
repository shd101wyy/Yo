# A generic function storing a by-value `T := &String` parameter emits C that re-borrows the parameter

**Severity:** S2 — the C compiler refuses the program (`incompatible pointer types`), no binary

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-generic-function-storing-a-by-value-reference-parameter-emits-invalid-c.yo`.

`yo check` accepts it; clang rejects the emitted C: `incompatible pointer types initializing 'const … *'`. Also `p04b_generic_store_binding.yo`.

## Root cause

The parameter half of `issues/2026-11-06-a-generic-result-at-t-reference-is-lowered-as-a-projection.md` (VERDICTS-23 R3): a `T := &U` by-value slot is lowered as a borrowed place.

## Fix

with that issue (N2c/R3) (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

the R2 runtime canary of VERDICTS-23 §4 extended to a `store_g` call that reads the stored reference after the call.
