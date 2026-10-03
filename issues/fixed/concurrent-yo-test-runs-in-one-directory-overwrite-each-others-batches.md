# Two `yo test` runs over the same directory overwrite each other's batch files

**Severity:** S3 — concurrent runs in one checkout fail or report the wrong verdicts. CI runs one suite per checkout and is unaffected.

**Status: OPEN.** Found 2026-09-30 while A/B-ing two compiler binaries on the same tree.

## Symptom

```
cd <checkout>
YO_STD=$PWD/std yo-a test ./tests --exclude tests/internal --exclude tests/cli-cases &
YO_STD=$PWD/std yo-b test ./tests --exclude tests/internal --exclude tests/cli-cases &
wait
```

One run ended after a few minutes with

```
yo: error: permission denied
```

(no summary line). The other kept going on batch files the first had
rewritten underneath it.

## Cause

`src/main.yo` (the test runner, "Write the batch program NEXT TO the test
file") names every batch

```
batch_base := `${batch_dir}/.yo_selftest_batch_${fi.to_string()}_${bi.to_string()}`;
```

`fi` and `bi` are the file and batch indices inside ONE run, so two
processes testing the same directory generate the same `.yo`, `.c` and
`.bin` paths, and each compiles, runs and deletes the other's files.

The batch has to live next to the test file, so that relative imports
resolve. Moving it to `/tmp` is not an option.

## Where it bites

Agents run suites concurrently in shared worktrees: two binaries A/B'd on
one tree, or two sessions in one checkout. The failure looks like a flaky
test or a permissions problem, not like a collision.

## Fix

Add the runner's process id to the name,
`.yo_selftest_batch_<pid>_<fi>_<bi>`. The `.gitignore` entry
(`.yo_selftest_batch_*`) already covers it. Test: a `tests/internal` case that
starts two runner children on one fixture directory concurrently and expects
both summaries to be green.

## Fixed

Root cause: `run_test`'s `batch_base` (src/main.yo) named every batch
`.yo_selftest_batch_<fi>_<bi>` — a pure function of directory + file index +
batch index with no per-process component, so two concurrent `yo test` runs
over one directory generated identical `.yo`/`.c`/`.bin` paths and each
compiled, ran and deleted the other's batches mid-run (reproduced 2026-10-03
on Windows with a 6-file fixture: rcA=0, rcB=1, run B ending two files early
with `yo: error: file or directory not found` and 4 of its 12 tests failed).
Fix: the name now carries the runner's pid — `.yo_selftest_batch_<pid>_<fi>_<bi>`
— taken from a new portable `std/process.pid()` (`getpid(2)`, bound as
`GetCurrentProcessId` in `std/libc/windows.yo`; the libc layer alone cannot
serve both platforms because `<unistd.h>` declares no `pid_t` under the
Windows UCRT). Every consumer keys on the `.yo_selftest_batch_` prefix
(`.gitignore`, the codegen/evaluator batch detectors), so the pid slots in
after it; the pid also survives the RSS valve's exec-restart unchanged. The
runner additionally exports its own executable as `YO_EXE` to batch children
so a test can re-invoke the compiler running it. Test:
`tests/internal/concurrent_test_runs.test.yo` builds a 6-file fixture under
`tmp/`, starts two runner children on it concurrently via `Command.spawn`,
and asserts both exit 0 (red before the fix — no `YO_EXE`, and the manual
concurrent pair failed rcA=0/rcB=1; green after, twice, and the manual pair
now ends rcA=0/rcB=0 with 12/12 in both). Fixed 2026-10-03 on branch
`s3/batch-3-fixes`.
