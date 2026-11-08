# A closure body stores a per-call reference parameter through another parameter or into a `&mut` capture

**Severity:** S1 — use-after-free in safe code: a reference that lives for one call of the closure outlives it

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-closure-body-stores-a-per-call-reference-parameter-through-another-parameter.yo`.

`yo check` accepts it ("evaluator OK", tree binary at develop `8d475cd81` and later); compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free`. The capture forms (`h2_closure_param_into_capture_string.yo`, `h2b_closure_fnmut_slot.yo`) crash codegen instead (`issues/fixed/2026-11-07-a-closure-capturing-an-origin-carrying-local-crashes-codegen.md`).

## Root cause

A closure literal's parameters are rigid per-call origins only for RETURNS (E0912), not for STORES; O3-3's exact unification is not applied inside literal bodies.

## Fix

O-3 (VERDICTS-37). Every elided `&` written in a parameter type is a rigid origin of the body: `rigid_param_slot` and
`param_declared_origin_slot` in `src/evaluator/utils.yo`, recognising a literal's parameters by their parameter frame.
A store through another parameter is E0923 (`_bind_join_subset_check`). A store through a `&mut` capture is E0923 for
a per-call parameter root and E0912 for a body local (`_capture_store`); any other root joins the outer holder's flow
set at the literal.

## Test that pins it

Corpus rows `closure-param-through-param` and `closure-param-into-capture-inline`. G-B
`tests/origins/unsound/h2dr-closure-two-params.yo`, `h2-closure-param-into-capture.yo`, `h2b-closure-bound-fnmut.yo` and
`h2e-closure-capture-holder.yo` (E0923), each with an ASan-clean positive twin.
