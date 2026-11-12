# The origins job is cancelled at its 60-minute cap

**Severity:** S3 — CI only: develop's merge gate fails although every origins gate passed.

Battery `43204313320` (develop `4f8f975b3`, #1918): the job "Origins corpus, unsound programs, origin totality (G-A, G-B, G-E)" ran G-A today (9 min), G-B (28 min) and G-E totality (15 min) green, then was cancelled 8 minutes into the informational `G-A corpus target set` step when it reached `timeout-minutes: 60`. A cancelled job fails `merge-gate`.

## Cause

#1918 made G-E's totality audit check `./src` with the project's dependencies installed (before, `./src` failed fast with a missing `markdown-yo` and went unaudited), which added about 14 minutes. The job's 60-minute cap predates that, and the G-B directory keeps growing with every origins fix.

## Fix

`.github/workflows/test.yml`: the job's cap is 100 minutes, and the informational target-set step has its own 20-minute cap (it is `continue-on-error`, so a slow run there can no longer cancel the job).
