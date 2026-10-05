# The suspension-analysis internal test still passed a three-parameter detector

**Severity:** S3. This is a test-only defect, but it turned the `tests/internal` CI shard 2 red on develop from #1204 onward.

## Symptom

`tests/internal/suspension_analysis.test.yo` failed to compile:
"Anonymous function: expected 2 regular parameters, got 3". It failed on develop
`1ad3c47b7` and `20f8c99ff`, and on every PR's CI that ran shard 2. The String
S3a agent found it while reading #1190's CI.

## Root cause

V2a (#1204) changed `SuspensionPointDetector.detect`
(`src/evaluator/shared/suspension_analysis.yo`) from pushing into a handed-in
`points` list to returning the points it detects. That list is passed by value,
so once collections are values the push would land in a copy. The walker
appends what `detect` returns. `src/evaluator/async/await_analysis.yo` was
updated, but the two fake detectors in this internal test were not. Local
gates did not catch it: `tests/internal` is a CI shard, and the V2a gate ran
only a subset of it.

## Fix

Both test detectors take `(expr, parent_expr)` and return an
`ArrayList(SuspensionPoint)`. The "detect all" detector numbers its points from
a shared counter cell (`box(usize(0))`), because it no longer sees the
accumulated list. That is the same way the real detector keeps its own state.

## Test

The file itself is the test: it fails to compile before the fix and passes after.
