# The origins job outgrows its 100-minute cap

**Severity:** S3 (CI only: every gating step passes, but the job is cancelled while it runs its
informational last step, and a cancelled job fails `merge-gate`. No compiler or program is affected.)

## What

Develop battery 43680143543 (`82c6588a0`) concluded `cancelled`. Its job "Origins corpus, unsound
programs, origin totality (G-A, G-B, G-E)" was stopped with "The job has exceeded the maximum
execution time of 1h40m0s" during the informational step "G-A corpus target set". Every gating step
had already passed:

| Step | 38b10f4f0 (battery 43647918952) | 82c6588a0 (battery 43680143543) |
| --- | --- | --- |
| G-A corpus (today) | 6.5 min | 10.7 min |
| G-B unsound programs (ASan) | 40.3 min | 71.0 min |
| G-E origin totality | 9.9 min | 15.0 min |
| G-A target set (informational) | 6.8 min | cancelled at the cap |
| job | 64 min | 100 min (cap) |

The second runner was about 1.6× slower across all steps, so this is runner variance, not a hang.
The variance landed on a budget with little headroom: G-B grows with every borrow-checker PR (382
programs on develop today) and, like G-E, it compiles and checks real code.

This is the second time: `issues/fixed/2026-11-12-the-origins-job-is-cancelled-at-its-60-minute-cap.md`
raised the cap from 60 to 100 minutes for the same reason.

## Fix

`timeout-minutes: 150` on the job, with the measurements in the workflow comment. That is 1.5× the
slow run's gating time, which leaves headroom for further G-B growth.

## Test

The develop battery itself: the job concludes `success` within the cap. If it outgrows 150 minutes,
shard G-B instead of raising the cap a third time.
