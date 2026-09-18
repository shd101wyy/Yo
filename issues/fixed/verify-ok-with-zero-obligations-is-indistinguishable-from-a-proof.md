# `yo verify` reports `ok` for a function that generated zero obligations

**Status:** FIXED 2026-09-18 (`plans/SELF_VERIFICATION.md` M0).
**Found:** running `yo verify ./src --format json` for that plan's baseline.
**Severity:** a vacuous pass reads exactly like a proof; counts of "verified
functions" overstate coverage.

## Symptom

Over `./src`: 57 functions report `ok`; 55 of them have `obligations : []`.
Nothing was proved about them — the body simply produced no AoRTE or contract
obligation (no index, no division, no shift, no `assert`, no contract). In the
text report and in the JSON `outcome` field they are identical to the two
functions that discharged real obligations.

## Why it matters

The self-verification sweep (`plans/SELF_VERIFICATION.md` M0) ratchets on the number
of verified functions; the Bend-lessons plan's `--strict` gate (B0) decides
pass/fail per outcome. Both need to tell "proved" from "nothing to prove".
This is the verifier-side twin of the hollow-green test pitfall (a batch that
runs nothing reports `N passed`).

## Fix — LANDED

One exported predicate, `verify_report_is_vacuous` (`src/verifier/driver.yo`),
asked by both renderers in `src/main.yo` so the text and the JSON can never
disagree, and by the self-verification ratchet so it counts only functions that
discharged something. Text prints `ok  <fn> [mode] — no obligations`; JSON
gains a `vacuous` boolean on every report. `--strict` (B0 of the Bend plan)
will keep treating it as passing.

Measured on the `./src` sweep: 52 `ok`, of which **50 are vacuous** and 2
discharged an obligation. Test: `tests/internal/verifier.test.yo` pins all
three cases (ok + zero obligations, ok + a discharged obligation, a non-`ok`
outcome with zero obligations).

## Original fix sketch

Keep `ok` as the outcome (a vacuous function IS fine to pass) but make the
report say so: text `ok (no obligations)`; JSON `vacuous : true` alongside
`obligations`. `--strict` keeps treating it as passing; the S0 sweep counts it
separately. Driver site: the outcome fold in `src/verifier/driver.yo`
(`verify_and_strip_tasks`, the `worst` → outcome mapping ~L675).

## Test

`tests/internal/verifier.test.yo`: a mocked report with an empty obligation
list renders `ok (no obligations)` and `vacuous : true`; a fixture with one
discharged obligation renders plain `ok`.
