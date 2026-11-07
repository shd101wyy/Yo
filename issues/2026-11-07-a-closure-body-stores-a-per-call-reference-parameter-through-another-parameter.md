# A closure body stores a per-call reference parameter through another parameter or into a `&mut` capture

**Severity:** S1 — use-after-free in safe code: a reference that lives for one call of the closure outlives it

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-closure-body-stores-a-per-call-reference-parameter-through-another-parameter.yo`.

`yo check` accepts it ("evaluator OK", tree binary at develop `8d475cd81` and later); compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free`. The capture forms (`h2_closure_param_into_capture_string.yo`, `h2b_closure_fnmut_slot.yo`) crash codegen instead (`issues/2026-11-07-a-closure-capturing-an-origin-carrying-local-crashes-codegen.md`).

## Root cause

A closure literal's parameters are rigid per-call origins only for RETURNS (E0912), not for STORES; O3-3's exact unification is not applied inside literal bodies.

## Fix

O-3 (rigid literal origins), v0.2.77 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

corpus rows `closure-param-through-param`, `closure-param-into-capture-inline`; the repro under `tests/origins/unsound/`.
