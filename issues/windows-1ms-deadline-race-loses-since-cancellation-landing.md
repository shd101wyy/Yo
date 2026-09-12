# On Windows, the 1 ms deadline race loses to the 5 ms work — since the cancellation landing

Status: OPEN (pre-existing on `origin/develop` @ d6d910f0; first exercised by
PR #614's CI on 2026-09-12).

## Reproducer (CI)

```
tests/async/while_await_in_match_arm.test.yo
  ✗ plain arm awaits once, looping arm polls to completion
    Test failed with exit code 22
    a 1ms deadline beats the 5ms work (at std/assert.yo:39:17)
```

`test (windows-latest)` and `test (windows-11-arm)` fail this assertion
deterministically (3 consecutive runs for #614, both legs). Linux and macOS
legs pass it.

## Why it surfaced on #614 and not on #608's own PR

- The emitted C for this test on #614's tree differs from the pre-#608
  emission ONLY in the cancellation machinery (`cancel_fn`,
  `cancel_pending_fn`, the abort/io-cancel runtime sections) — zero hunks
  from #614's own diff (verified by diffing the batch C against a
  Phase-2-only compiler; see the analysis in #614).
- #608's PR branch ran the Windows matrix on ITS merge base. The pushes of
  #608's and #610's merge commits were classified docs-only
  ("Classify the diff" fast path) and SKIPPED the test matrix —
  develop-tip runs show 15 skipped / 3 success. So the #608+#610
  combination had never run on Windows until #614.
- Draft PR #621 (a no-op commit on develop's tip) re-runs the matrix to
  confirm pre-existence independently of #614.

## Hypothesis (unverified)

The cancellation path (#608, "std/async: yield has no timer under it any
more") changed how a 1 ms race deadline is armed/observed relative to
5 ms of queued work on Windows's coarser timers — the deadline now fires
after the work completes (or the work's completion is observed first), so
the race resolves to the work arm (`c == 101` instead of `200`). The
assertion encodes Linux-tuned timing assumptions.
