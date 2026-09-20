# `tests/spawn_blocking.test.yo` hangs the macOS test leg for four hours, because the test-run child has no deadline

**Status:** FIXED 2026-09-20 (root cause below; the deadline is a follow-on, deliberately not shipped — the maintainer asked for the cause, not a cap). **Found:** 2026-09-19, triaging a CI failure on an unrelated PR.
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

## Root cause (2026-09-20)

Not the kqueue channel and not the 100 ms wait — a **lost wake in the
waker token's LOCAL release** (`__yo_waker_release`, `src/codegen/async/runtime_core.yo`).

`spawn_blocking` hands the worker thread a copy of the park's waker and keeps
its own copy in the spawning frame until that frame ends. On an idle machine
the frame ends first: the owner's copy is released locally (future dropped,
`t->future = NULL`), the worker later wakes through the FOREIGN path, whose
release defers the future drop to the drain. Fine. On a loaded runner the loop
thread is descheduled right after `pthread_create`; the worker finishes its
callee, sends the value and calls `w.wake()` first — the token is now on the
owner's inbox (`queued = 1`) — and only THEN does the frame drop its copy.
The local release nulled `t->future` regardless, and the drain does
`if (t->future) __yo_waker_wake_local(...)`: the queued wake was skipped, the
park future stayed pending forever, and the loop spun in
`__yo_async_drain_xwakes` / `__yo_async_drain_yields` with nothing pending
(`sample` of the hung process shows exactly that; `live_wakers` is 0 by then,
so the wake-deadlock report is silent).

Deterministic reproduction (any macOS/Linux box, develop before the fix):

```rust
p := Park.new();
{
  w := p.waker();
  worker := Thread(unit).spawn((tio : Io) => { w.wake(); () });
  worker.join();          // the wake is on the inbox before `w` drops below
};
io.await(p.wait(io), io); // hangs
```

Swap the order (worker sleeps 30 ms then wakes; the frame drops `w` at once)
and it passes: that is the foreign-release path. Local hammers of the test file
(0 hangs in 60 direct runs here; 0 in 67 runs on a second idle M4, 52×8 s, 7×9 s, 1×10 s) never hit it —
the window needs the loop thread to lose the CPU right after the spawn.

## Fix

In the local release, check `t->queued` under the owner's lock (the post links
under that same lock right after its CAS) and, if the token is on the inbox,
set `release_pending` and let the drain drop the future AFTER delivering the
wake — exactly what the foreign path already did.

## Gate

`tests/cross_thread_wake.test.yo` "a wake posted before the owner drops its
waker copy still resumes the park": the join makes the ordering deterministic,
so it hangs every time on the unfixed runtime and passes after. Its sibling
"the common ordering … still resumes promptly" is the over-rejection canary:
the foreign-release path must stay as fast as before.
