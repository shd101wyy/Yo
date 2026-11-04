# The build runner's cc-probe test fails on every rerun on one box

**Severity:** S3 — a test-hygiene defect: a correct compiler fails a gate
(`tests/internal/build_runner.test.yo`) on any machine that has run the file
before, so a local Tier 1 reports a false failure.

**Status:** FIXED 2026-11-03 on `vbd/w6b-delete-collector`. **Found:** 2026-11-03 by agent w6b, running the
file through its tree binary on the shared Linux box.

## Symptom

```
✗ the build's default C compiler is probed, not the literal clang
  a PATH with cc but no clang resolves cc, got "clang" (at .../std/assert.yo:39:17)
17 passed  1 failed  18 total
```

## Root cause

The test (added by #1701) copies its own binary into
`/tmp/yo_build_cc_probe_fixture` as `cc`, probes, then copies it in as
`clang` and probes again. The directory is a fixed path and is never
removed, so the `clang` from any earlier run is still there when the next
run's "cc but no clang" probe runs: the probe finds `clang` first and the
assertion fails. On the box the directory dated from 2026-10-31; every run
since then failed this case. A fixed `/tmp` path also collides between
concurrent runs from different worktrees, the hazard `AGENTS.md` names for
`tests/internal`.

## Fix

The two fixture directories carry the process id
(`/tmp/yo_build_cc_probe_fixture.<pid>`, `..._empty.<pid>`) and are removed,
tolerating absence, before the assertions run. The test itself is the
regression test: it failed on the box with the stale directory present and
passes after the change.
