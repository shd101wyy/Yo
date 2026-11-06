# `cond`/`match` arm results holding references join only one arm's roots

**Severity:** S1 — use-after-free in safe code: the root of the arm that was not recorded is freed while the joined value is live

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-cond-and-match-arm-results-holding-references-join-only-one-arms-roots.yo`.

`yo check` accepts it ("evaluator OK", tree binary at develop `8d475cd81` and later); compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free`. Also `h5b_match_join_rc.yo`, `h5r_cond_join_rc.yo`, `p38_cond_option_join.yo`.

## Root cause

R-ARM (decision 38 A's "borrow sets join") is not built for composite arm results.

## Fix

O-1, v0.2.76 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

corpus rows `cond-arm-composite`, `match-value-arm-composite`; the repro under `tests/origins/unsound/`.
