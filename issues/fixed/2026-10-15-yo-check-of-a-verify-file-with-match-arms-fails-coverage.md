# `yo check` of a `[verify]` file whose functions use `match` fails evaluator coverage

**Severity:** S3. A tree file fails a `yo check` sweep, but nothing miscompiles. CI runs this file only through the language suite (`yo test`, as runtime asserts); no workflow runs `yo check` or `yo verify` on it (the FV job verifies only `tests/spec/verify_straight_line.test.yo`).

**Status:** FIXED 2026-10-20 (branch `fix/check-verify-match-coverage`). Found 2026-10-15 while gating `feat/global-lend-to-call-is-an-error`, and reproduced on develop with seed v0.2.62.

## Repro

`yo check tests/spec/verify_match_patterns.test.yo --std-path ./std` returns rc 1 with `yo: error: check: 1 file(s) failed evaluator coverage`. It prints six lines like:

```text
subset   fn@tests/spec/verify_match_patterns.test.yo:19 [verify] — cannot verify: match arms not registered (the pattern table is off)
```

at lines 19, 35, 45, 54, 65 and 75. They are emitted from `src/verifier/vc.yo` (around L2345).

## Cause, as far as known

Under `check`, the pattern table that records `match` arms for the verifier is off, so the verifier's subset walk cannot model a `match` and reports the function as uncovered. `check` then counts that as a coverage failure. `plans/reference/MATCH_PATTERN_MATCHING.md` (L176–188) covers seed-gating for `yo verify`, not this `check` path.

## Fix direction

Either:
- register match arms under `check` whenever a `[verify]` function needs them; or
- make the verifier's "pattern table is off" outcome a skip with a hint under `check`, the way a missing Z3 is (#760), rather than a coverage failure.

Add a `yo check` of this file to a test that fails before the fix and passes after.

## Resolution (2026-10-20)

The cause was as diagnosed. `check` calls `set_codegen_tables_enabled(false)`
(plans/EVALUATOR_MEMORY_REDUCTION.md §0.21), and `register_match_arms` was
gated on that switch, so no match arms were recorded. `check` still runs the
verifier on every verify-mode file (`_run_contract_verification`), and the
verifier's `_match_term` reads the arms through `lookup_match_arms`. Every
function containing a `match` was therefore a subset failure under `check`,
while `yo verify`, which keeps the tables on, proved it.

**Fix:** the compiled match arms get their own switch,
`set_match_arms_table_enabled` / `match_arms_table_enabled` in `src/utils.yo`,
which is on by default. `register_match_arms` reads that switch. `check` turns
off only the codegen-only tables (match modes, arm-entry drops, await
analyses, fusion candidates). `doc` and the LSP neither generate code nor
verify, so they turn both off. The arms are recorded for every module, not
only for verify targets, because a spec-transparent callee
(`_transparent_call_term` in `verifier/vc.yo`) can lead the walk into a
`match` in any imported module.

Not taken: reporting "the pattern table is off" as a skip with a hint. This
box has Z3, so `check` really runs the proofs here, and skipping every
function that uses `match` would silently drop the coverage `check` exists to
measure.

**Measured** (Mac Mini M4, tree binaries built from the same develop
`src/` with and without the fix):

- `yo check tests/spec/verify_match_patterns.test.yo --std-path ./std`
  returns rc 1 before the fix (the six "match arms not registered" lines).
  After it, rc is 0 and all six functions report `ok … 1 obligation(s)
  proved`.
- The memory cost is the arms table `check` now keeps. `check src/main.yo`
  max RSS went from 1,224,523,776 to 1,230,585,856 bytes (+6.1 MB, +0.5 %),
  and wall time was 135.0 s before, 132.0 s after (noise).

**Tests:** `tests/internal/verifier_match.test.yo` gets "the match walk has
its arms under check's settings (codegen-only tables off, solver-free)". It
loads `tests/spec/fixtures/valid/match_enum.yo` with the codegen-only tables
off and asserts that the VC walk reports no subset error. Measured
fails-before: the same test file run against develop's `src/` (worktree at
`6ccddf25d`, its tree binary) passes the two older cases and fails this one
(exit code 6, the assert); with the fix, all three pass. A cli-case cannot carry this
test: the sandbox `HOME` has no solver, so `check` returns before the walk
runs. `tests/internal/module_invalidation.test.yo`'s registry test now covers
both settings: `check`'s still records arms, `doc`/LSP's records none.
