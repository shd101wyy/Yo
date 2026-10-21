# `check_watch.test.yo` fixtures share fixed `/tmp` directories across concurrent runs

**Severity:** S3 — two `tests/internal` runs on one machine that reach `check_watch.test.yo` at the same time rewrite each other's fixture files, so a test fails (`Test failed with exit code 6`) with no change in the compiler; a Tier 1 run then reports a red result that is not about the change under test.

**Status:** open. Found 2026-10-21 while gating `perf/non-cloning-mut-global-caches`.

## Evidence

- Every fixture in `tests/internal/check_watch.test.yo` writes to a fixed path:
  `/tmp/yo_check_watch_fixture`, `..._p3`, `..._p3b`, `..._p3b_sig`, `..._p3b_dir`,
  `..._p3b_ty`, `..._rebind`, `..._rebind_renamed`, `..._rebind_ordered`, `..._d1_memo`,
  `..._build_watch`. None carries the runner's pid.
- On 2026-10-21 at 08:45 three in-process `tests/internal` runs (three worktrees, three
  agents, `YO_TEST_IN_PROCESS=1`) started together under the heavy lock's per-slot admission.
  In one of them, `build --watch: invalidate_changed_files makes an edited import re-read on
  the next load` failed with exit code 6 (an `assert` abort); the other 1,422 tests passed.
- The same test, run alone right afterwards with the same binary and with the develop
  binary (`--test-name-pattern "build --watch"`), passed with both.

## Root cause

The test writes `lib.yo` V1, loads, writes V2, then asserts on the value it reads back. A
second run that rewrites `/tmp/yo_check_watch_fixture_build_watch/lib.yo` between those steps
changes what the first run reads. The batch artifacts already carry the pid
(`issues/fixed/concurrent-yo-test-runs-in-one-directory-overwrite-each-others-batches.md`);
these fixture directories do not.

## Direction

Suffix each fixture directory with the process id (or a `mkdtemp`-style unique name) and
remove it at the end of the test. The regression test is a run of two copies of
`check_watch.test.yo` at once, in the shape of `tests/internal/concurrent_test_runs.test.yo`.
