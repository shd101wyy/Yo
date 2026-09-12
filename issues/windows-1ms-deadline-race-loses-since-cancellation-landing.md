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

## Root cause (confirmed by code reading, 2026-09-12)

#608 removed the 1 ms timer under `yield` (it is now the timer-free
fairness handoff `__yo_async_yield_start`). The race test's poll loop
(`while(!h.fin && !dh.fin) { await yield(); }`) previously advanced ~1 ms
per turn because of that timer; now it spins in microseconds. On Linux the
io_uring timers still expire at distinct real times (1 ms < 5 ms), so the
deadline task strictly finishes first. On Windows the runtime's clock is
`GetTickCount64()` (~15.6 ms granularity): the 1 ms and 5 ms dues are both
satisfied by the same tick reading, the first real pump fires BOTH timer
entries in one `__yo_win_timer_process_due` batch, both tasks complete
together, and the loop's `cond(h.is_finished() => 101, ...)` tie-break
awards the work task (spawned first). Result 101, expected 200 —
deterministically, because the granularity gap (1 ms vs 15.6 ms) is
structural.

The pre-existence proof: draft PR #622 (a comment-only source change on
develop's tip) fails `test (windows-latest)` at exactly this assertion —
while #608's and #610's own merge pushes were classified docs-only and
SKIPPED the matrix, so this combination had never run on Windows before
PR #614.

## Fix direction

Give the Windows runtime deadline precision: derive `__yo_win_now_ms` from
QPC (`QueryPerformanceCounter`, sub-microsecond) instead of
`GetTickCount64`, and arm the `__yo_io_wait` timeout from the QPC-scaled
next-due so a 1 ms deadline is actually waited for (the GQCSEx timeout
itself is millisecond-DWORD, which suffices once `now` is fine-grained:
due_1ms and due_5ms then land in different polls, the deadline fires
first, and the test passes for the reason it does on Linux). Alternative
rejected: widening the test's margins would pin the OS, but the property
under test — a shorter deadline wins — is real and the runtime should
honor it.
