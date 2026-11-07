# `yo explain` E0911, E0912 and E0910 teach the pre-decision-43 model

**Severity:** S3 — documentation drift in the diagnostic contract: `yo explain E0912` says a local borrow is second-class and may not be returned or stored, which decision 43 replaced

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer


`yo explain E0912`: "a local borrow is second-class … may not be returned, stored"; `yo explain E0911`: "a live LOCAL borrow (`y := &place`)"; `yo explain E0910`: "In Generation A the closure lives until the end of its binding's scope". The evaluator raises E0912 with decision 43's text.

## Root cause

The registry entries in `src/diagnostics_registry.yo` were not rewritten at N2b/N1e.

## Fix

with the `--migrate deref` adoption PR (v0.2.76), beside E0926's text (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

`tests/internal/diagnostics_registry_examples.test.yo` pins the new texts.
