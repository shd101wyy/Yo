# `yo test` silently drops every path but the last

**Severity:** S3. A wrong but visible result: the run reports a smaller test
count than intended, with no error.

## Symptom

`yo test` takes one path (`Usage: yo test [path] [options]`). Given several,
it ran only the last and said nothing about the others:

```text
$ yo test ./tests/async/waker.test.yo ./tests/async/mutex.test.yo --list | cut -f1 | sort | uniq -c
      5 ./tests/async/mutex.test.yo
```

A gate script that listed the async test files in one call reported
"14 passed" for the last file alone, and read as green for all of them.

## Root cause

The positional arm of the argument loop in `src/main.yo` (the `test`
subcommand) assigned `target_path = a` for every non-option argument, so each
path replaced the one before.

## Fix

A second positional path is an error naming both paths:

```text
test: one path per run, got 'alpha.test.yo' and 'sub'. Run each separately, or pass their common directory (with --exclude for what to skip)
```

Test: the CLI case `tests/cli-cases/test-two-paths`.
