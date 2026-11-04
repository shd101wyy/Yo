# The formal-verification CI job outgrows its 120-minute timeout after the collection flips

**Severity:** S3 — CI plumbing: a green tree's develop battery is cancelled at the job's cap, so the release battery reports no verdict and has to be re-run.

**Status: FIXED** on `fix/develop-fv-timeout-after-b8-b9`. Found 2026-11-04 on develop `a3c0d2dcc` (the v0.2.74 release candidate).

## Symptom

Run 41716173890 (develop `a3c0d2dcc`): every other finished job green, and `Formal verification (pinned Z3)` **cancelled** at 120 min 20 s, in its `Verifier list-model tests` step. Nothing failed; the step's tests were passing when the job hit `timeout-minutes: 120`.

## Cause

The job runs five `tests/internal/verifier_*` files in sequence, and each file compiles the compiler with the stage-1 binary. The VBD collection flips (B8 #1736, B9 #1737, B10 #1741, B11 #1743, V2c #1735) made the compiler's evaluator slower on the compiler's own source: the memory ratchet re-baseline #1742 records `check src/main.yo` allocation calls 2,449,599,225 → 6,176,004,922 and max RSS +34%. The job was already close to its cap before the flips.

| Step (minutes) | 41539921198 (`ce827ae52`, pre-flip, green) | 41716173890 (`a3c0d2dcc`, cancelled) |
| --- | --- | --- |
| unit tests | 3.3 | 4.6 |
| negative-path | 21.6 | 26.2 |
| assumed-contract | 14.3 | 16.6 |
| refinement | 16.2 | 19.8 |
| list-model | 56.8 | > 52.2 (cancelled) |
| **job** | **113** | **120.3 (cap)** |

At ~1.2x per step, the list-model step needs ~68 min and the job ~140 min.

## Fix

`timeout-minutes: 180` for the job, with the measurement in the workflow comment. The timeout exists to bound a hang; 180 still does that while leaving ~1.3x margin over the projected run. Reclaiming the evaluator's cost is the post-VBD sharing work (`plans/EVALUATOR_MEMORY_REDUCTION.md`), which would also shorten this job.

Test: CI plumbing only. The next develop battery shows the job's verdict instead of `cancelled`.
