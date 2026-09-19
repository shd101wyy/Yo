# `tests/spawn_blocking.test.yo` hangs the macOS test leg for four hours, because the test-run child has no deadline

**Status:** OPEN. **Found:** 2026-09-19, triaging a CI failure on an unrelated PR.
**Severity:** a ~1-in-4 lottery that burns a 240-minute runner slot and reports
nothing actionable. Six occurrences in three days, on `develop` and on
unrelated branches.

## Symptom

`test (macos-latest)` runs to the job's `timeout-minutes: 240` cap and is
cancelled. The log's last real activity is early; the job then sits silent for
hours and ends with:

```
##[error]The operation was canceled.
Terminate orphan process: pid (…) (.yo_selftest_ba)
```

The healthy duration of that job is **35–51 minutes**, so a four-hour run is
already the signal.

## Occurrences

Six in three days — **including two on `develop` itself**, which is what rules
out any particular PR:

| job | commit |
| --- | --- |
| 105409949044 | `f55352406` (develop) |
| 105590227103 | `e6238fafa` (develop) |
| 105709568918 | PR #772 |
| + three more on unrelated branches | |

## Two separate defects

**1. The hang itself.** `tests/spawn_blocking.test.yo` stops after its first
test on macOS arm64. Suspected a lost cross-thread wakeup in the
`spawn_blocking` bracket (`std/sys/externs.yo`, `std/async/waker.yo`). Not
root-caused here.

**2. Why it costs four hours instead of minutes — the actionable one.**
`src/main.yo` awaits the test-run child with **no deadline**, while the same
file already bounds the batch *compile* child with `--compile-timeout-ms`
(default 600000). So a hung test has nothing to stop it short of the job cap.

## Fix

Bound the test-run child the way the compile child is already bounded: a
wall-clock cap that kills the process and reports `✗ <name>` with a named
timeout. `tests/spawn_blocking.test.yo` normally completes in about ten
seconds, so a few minutes is generous. That converts every future instance
from a four-hour black hole into a named failure in minutes — and, unlike
lowering the job's `timeout-minutes`, it produces a *diagnosis* rather than
just a shorter burn.

Lowering `timeout-minutes: 240` is a follow-on, not a substitute.

## Verification

Reproduce by hammering the file on an arm64 Mac:

```bash
for i in $(seq 1 40); do
  echo "=== $i ==="
  timeout 300 yo test ./tests/spawn_blocking.test.yo --parallel 1 || echo "HANG/FAIL at $i"
done
```

Before the fix a hang shows as a bare `timeout` with no verdict; after it, the
run must exit non-zero naming the test within the cap.

Nearest sibling, same shape, already fixed:
`issues/fixed/d6-schannel-hangs-the-windows-test-legs-for-four-hours.md`.
