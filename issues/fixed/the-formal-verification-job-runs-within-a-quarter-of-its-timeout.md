# The formal-verification CI job runs within a quarter of its timeout

**Severity:** S3 — CI plumbing: a green tree's battery is cancelled when its runner is slow, so a develop battery reports no verdict and has to be re-run.

**Status: FIXED** on `ci/fv-timeout-headroom`. Found 2026-10-04 on develop `cd3454b0e`.

## Symptom

Run 37170165556 (develop `cd3454b0e`, #1178): 41 of 42 jobs green, and `Formal verification (pinned Z3)` **cancelled** at 60 min 12 s, in its `Verifier list-model tests` step. Every earlier step had passed. Nothing failed: the job hit `timeout-minutes: 60`.

## Cause

The job runs five `tests/internal/verifier_*` files in sequence, and each file compiles the compiler. Measured step times on two green runs of the same tree family:

| Step | PR #1178 (`5fe7b9ce7`) | PR #1167 (`e6804c849`) | develop `cd3454b0e` (cancelled) |
| --- | --- | --- | --- |
| unit tests | 2.0 min | 1.8 min | 2.6 min |
| negative-path | 9.7 | 9.3 | 13.7 |
| assumed-contract | 6.8 | 6.5 | 9.9 |
| refinement | 7.5 | 7.3 | 10.8 |
| list-model | 19.9 | 18.9 | > 22.9 (cancelled) |
| **job** | **46.6** | **44.5** | **60.2** |

The nominal job takes 44–47 minutes. The develop run's steps each took about 1.45× as long: three batteries were sharing the runner pool at the time. A 60-minute timeout leaves 28 % headroom, less than ordinary runner variance.

## Fix

`timeout-minutes: 90` for the job. The timeout's purpose is to stop a hang, and 90 minutes still does that, about twice the nominal time. It no longer cancels a passing run on a slow runner.

Test: CI plumbing only. The next develop battery shows the job's verdict instead of `cancelled`.
