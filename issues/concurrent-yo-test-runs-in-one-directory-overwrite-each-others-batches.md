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
