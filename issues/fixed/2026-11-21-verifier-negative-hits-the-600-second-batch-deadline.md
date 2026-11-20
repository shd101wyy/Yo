# verifier-negative hits the 600-second batch deadline in the FV harness job

**Severity:** S2. The release gate needs a green battery on the exact tip, and
this turns develop's battery red with no failing assertion: the only batch of
`tests/internal/verifier-negative.test.yo` is killed by the test runner's
compile deadline. It is the same failure mode as
`issues/fixed/compile-test-hits-the-600-second-batch-deadline-in-the-differential-job.md`,
this time in the `Formal verification (pinned Z3, harness)` job.

**Status: FIXED 2026-11-21.** Every verifier step of the FV job passes
`--compile-timeout-ms 1200000` to `yo test`.

## What happened

It happened first on develop run 44700622640, attempt 1 (c012cfb30). The step
`Verifier negative-path tests (subset + refutations)` started at 10:48:21 and was
killed at 10:58:23, 602 s later:

```
yo: error: Yo compilation exceeded the configured time limit (possible evaluator hang). See issues/fixed/test-runner-no-compile-timeout.md.
yo: error: test: ./tests/internal/verifier_negative.test.yo — 0 of 10 tests in this batch ran: the batch failed to compile (exit != 0).
```

A rerun of the failed job passed, so it was logged as a flake. The same step
then failed again on the release-candidate battery 44757876591 (cc95ab2d7, the
v0.2.79 tip). By the rule that a second failure of the same job is real, this is
a margin problem, not a flake.

## Root cause

`yo test` gives each batch's child compile `--compile-timeout-ms 600000` unless
told otherwise (`src/main.yo`, the test runner's child argv). Every
`tests/internal/verifier*.test.yo` file evaluates the whole compiler. R7 (the
parser drop) and the `EvalValue` retype raised the evaluator's work on
`check src/main.yo` by 36.8% (the allocation ratchet went from 7,737,272,500 to
10,588,125,544). That pushed this batch's comptime on the hosted runner to
about 600 s, so whether it passes now depends on the runner's speed that day.

## Fix

The five verifier steps (`verifier`, `verifier-negative`, `verifier-assumed`,
`verifier-refine`, `verifier-list-len`) pass a 20-minute batch deadline. That
matches the differential job. A real evaluator hang is still caught well inside
the job's time limit. The test is the CI step itself: it failed before the
change, at 602 s, and passes after it with the larger budget.

Making the evaluator faster is the real cure. It belongs to the post-VBD
evaluator-performance work, not to this fix.
