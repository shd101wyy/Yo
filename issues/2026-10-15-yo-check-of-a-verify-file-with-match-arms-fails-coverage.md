# `yo check` of a `[verify]` file whose functions use `match` fails evaluator coverage

**Severity:** S3. A tree file fails a `yo check` sweep, but nothing miscompiles. CI runs this file only through the language suite (`yo test`, as runtime asserts); no workflow runs `yo check` or `yo verify` on it (the FV job verifies only `tests/spec/verify_straight_line.test.yo`).

**Status:** open. Found 2026-10-15 while gating `feat/global-lend-to-call-is-an-error`, and reproduced on develop with seed v0.2.62.

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
