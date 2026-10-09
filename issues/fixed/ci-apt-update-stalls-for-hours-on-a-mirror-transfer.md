# CI: `apt-get update` stalls for hours on a mirror transfer

**Severity:** S3: CI-only. One stalled runner holds a required job (and with it the `develop` battery) until someone cancels it or GitHub's 6-hour limit fires; no shipped code is affected.

## Symptom

`develop` run 37818650283 (#4655, commit 1cc275688): the job "Bootstrap
fixpoint (yo-self self-compile)" sat in its "Install GNU time" step from
2026-10-08 21:12 UTC until the maintainer cancelled it at 2026-10-09 01:55 UTC.
The step's log ends at

```
2026-10-08T21:13:11Z Get:5 http://azure.archive.ubuntu.com/ubuntu noble-security InRelease [126 kB]
2026-10-08T21:13:11Z Hit:2 http://azure.archive.ubuntu.com/ubuntu noble InRelease
2026-10-09T01:55:14Z ##[error]The operation was canceled.
```

so `apt-get update` stalled mid-transfer and printed nothing for 4 h 42 min.

## Root cause

`APT_OPTS` (`-o DPkg::Lock::Timeout=600 -o Acquire::Retries=3`) bounds the dpkg
lock wait (`issues/fixed/ci-apt-hangs-on-dpkg-lock.md`) and retries a FAILED
fetch, but neither bounds a fetch that never completes, and the step itself had
no time limit, so the job's 360-minute ceiling was the only bound.

## Fix

Every `sudo apt-get $APT_OPTS update` in `.github/workflows/` (24 sites in
`test.yml`, `release.yml`, `ubsan.yml`, `fixpoint-arm64.yml`) runs as
`sudo timeout 300 apt-get $APT_OPTS update`, tried up to three times. A stall
costs at most five minutes and then retries on a fresh connection; three
failures fail the step as before.

No test: the stall is a property of the runner's network, which no test in this
repository can provoke. The workflow comment beside `APT_OPTS` records it.
