# The formal-verification CI job outgrows its 180-minute timeout

**Severity:** S3. This is CI plumbing. On a green tree, the develop battery's `Formal verification (pinned Z3)` job is cancelled at its cap, so `merge-gate` reports red and a release battery gives no verdict.

**Status: FIXED** on `fix/develop-fv-split-list-model`. Found 2026-11-10 on develop `983a05e69`.

## Symptom

Two develop batteries in a row were cancelled at `timeout-minutes: 180`, both inside `Verifier list-model tests`, and both after about 101 minutes in that step. Nothing failed. The steps before it were green.

| Run | Head | Job | negative-path | refinement | list-model |
| --- | --- | --- | --- | --- | --- |
| 42605340282 | green | 151 min | 24 | 17 | 88 |
| 42625179142 | green | 170 min | 24 | 18 | 108 |
| 42677134002 | green | 114 min | 17 | 14 | 67 |
| 42708865105 | cancelled | 180 (cap) | 30 | 24 | > 101 |
| 42737388741 (`983a05e69`) | cancelled | 180 (cap) | 31 | 23 | > 101 |

## Cause

The job runs five `tests/internal/verifier_*` files in sequence, and each one compiles the compiler with the stage-1 binary. The compiler's evaluator keeps getting slower on its own source during VBD (`issues/fixed/2026-11-04-the-formal-verification-job-outgrows-its-120-minute-timeout-after-the-collection-flips.md`, which raised the cap from 120 to 180). A runner's speed varies by up to about 1.5x. With green runs already at 151 and 170 minutes, the job had no margin left.

## Fix

The cap was raised from 90 to 120 and then to 180. Raising it a third time would mean a 3–5 hour job on every develop battery. Instead the job becomes a two-leg matrix with `fail-fast: false`:

- `list-model` runs `verifier_list_len.test.yo` alone. That file is the longest, at 67–108 minutes.
- `harness` runs the other four verifier files and the `yo verify` steps, about 80–95 minutes.

Each leg keeps `timeout-minutes: 180`, a margin of about 1.6x, and the job's wall time is roughly halved. `merge-gate` already `needs: verify`, which covers both legs. The verify-report artifact is uploaded only by the `harness` leg. Reclaiming the evaluator's cost is post-VBD work (`plans/backlog/POST_VBD_PLAN.md` phase 2), and it would shorten both legs.

Test: CI plumbing only. The next develop battery shows both legs' verdicts instead of `cancelled`.
