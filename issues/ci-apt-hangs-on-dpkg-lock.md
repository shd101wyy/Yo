# CI jobs hang for hours on `apt-get`, and it is the dpkg lock, not the mirror

**Status: FIXED** (diagnosed and fixed 2026-08-20).

## Symptom

A job sits on its `Install liburing` step until `timeout-minutes` kills it.
GitHub reports a `timeout-minutes` kill as **cancelled**, not failed, so it
reads as a spurious cancellation and invites an endless re-run loop.

## The measurement that identifies it

Run 32303656711, one run, one moment, the same step in every job:

| `Install liburing` duration | outcome |
| --- | --- |
| 11 s, 16 s, 17 s, 120 s, 221 s, 227 s, 228 s, 257 s, 263 s | success (9 jobs) |
| **7204 s, 7206 s, 7207 s, 7210 s** | hung until the 120-minute timeout (4 jobs) |

`azure.archive.ubuntu.com` was answering in 0.9 s throughout.

**A mirror outage cannot produce that.** If the archive were down, all thirteen
jobs would hang, not nine-fast / four-forever. The split is per-RUNNER, which
points at something local to each machine.

## Cause

`apt-get` waits on `/var/lib/dpkg/lock-frontend` **indefinitely** by default,
and the GitHub runner images run `unattended-upgrades` / `apt-daily` timers in
the background. Whether one holds the lock when a job reaches its apt step is
luck of the runner — which is exactly the observed 9-vs-4 split. There is no
error output because apt is not failing; it is waiting, exactly as designed.

## An earlier occurrence was misdiagnosed

The same signature appeared on 2026-08-19 (run 32220286604, the
bootstrap-fixpoint stage-3 job, twice in a row) and was attributed to
`archive.ubuntu.com` being down. That explanation does not survive this
measurement: a down mirror cannot hang four runners while nine succeed against
it in the same minute. The retry that appeared to "fix" it most likely just
landed on a runner whose timer was not running.

Worth stating as a method note: **two failures inside one incident window are
not two independent samples**, and "it worked on retry" is not evidence of the
cause. The discriminator here was cheap and should have been reached for first —
compare the step's duration ACROSS jobs in the same run.

## Fix

Bound the wait so an infinite hang becomes a diagnosable failure, and retry
ordinary mirror flakiness:

```
-o DPkg::Lock::Timeout=600 -o Acquire::Retries=3
```

Applied to every `apt-get` call in the repository (28 call sites in
`test.yml` + `release.yml`, plus `fixpoint-arm64.yml` and the `build-stage1`
composite action). The flags are defined once per workflow as `APT_OPTS` so
they cannot drift between call sites; `build-stage1` spells them out instead,
because a composite action must not depend on an env var its caller happens to
define.

`DPkg::Lock::Timeout=600` still allows a legitimately busy background upgrade to
finish — it only refuses to wait forever.
