# E0909 is raised with three meanings (closure capture escape, the `Escapable` bound, a stored future) under one registry entry

**Severity:** S3 — one error code, three unrelated explanations; `yo explain E0909` matches only one

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-e0909-is-raised-with-three-meanings-under-one-registry-entry.yo`.

The `where(V <: Escapable)` text (this repro), the future text (`p22_future_option.yo`), and the registry's closure text.

## Root cause

The no-origin-position code was never split as `REFERENCES_AND_ORIGINS.md` §4 "New error codes" asked.

## Fix

v0.2.77: one registry entry per meaning, or the closure/future cases move to E0912/E0911 (VERDICTS-30 §2.2 item 2) (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

`tests/internal/diagnostics_registry_examples.test.yo` pins each meaning.
