# `yo verify` reports `ok` for a function that generated zero obligations

**Status:** OPEN. **Found:** 2026-09-18, running `yo verify ./src --format json`
for `plans/backlog/SELF_VERIFICATION.md`'s baseline.
**Severity:** a vacuous pass reads exactly like a proof; counts of "verified
functions" overstate coverage.

## Symptom

Over `./src`: 57 functions report `ok`; 55 of them have `obligations : []`.
Nothing was proved about them — the body simply produced no AoRTE or contract
obligation (no index, no division, no shift, no `assert`, no contract). In the
text report and in the JSON `outcome` field they are identical to the two
functions that discharged real obligations.

## Why it matters

The self-verification sweep (`SELF_VERIFICATION.md` S0) ratchets on the number
of verified functions; the Bend-lessons plan's `--strict` gate (B0) decides
pass/fail per outcome. Both need to tell "proved" from "nothing to prove".
This is the verifier-side twin of the hollow-green test pitfall (a batch that
runs nothing reports `N passed`).

## Fix

Keep `ok` as the outcome (a vacuous function IS fine to pass) but make the
report say so: text `ok (no obligations)`; JSON `vacuous : true` alongside
`obligations`. `--strict` keeps treating it as passing; the S0 sweep counts it
separately. Driver site: the outcome fold in `src/verifier/driver.yo`
(`verify_and_strip_tasks`, the `worst` → outcome mapping ~L675).

## Test

`tests/internal/verifier.test.yo`: a mocked report with an empty obligation
list renders `ok (no obligations)` and `vacuous : true`; a fixture with one
discharged obligation renders plain `ok`.
