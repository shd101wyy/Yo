# `yo test -k` keeps no generated files

**Severity:** S3 — `yo test --help` documents `-k, --keep-generated-files  Keep generated batch files`, but the flag is parsed and ignored, so the batch `.yo`/`.c` files are deleted anyway; only `YO_KEEP_BATCH=1` keeps them.

**Status:** open. Found 2026-10-29 while measuring decision 48 W6a's tracked-type count (`plans/backlog/WEAK_AND_UNCOLLECTED_RC.md` §6, precondition 3): `yo test ./tests/collections --cycle-collector auto -k` left no `.yo_selftest_batch_*` file behind, and the same run under `YO_KEEP_BATCH=1` kept them. Not fixed on the W6a branch, which does not touch the test runner.

## Reproducer

```sh
yo test ./tests/collections/deque.test.yo -k
ls -a tests/collections | grep yo_selftest_batch   # nothing
YO_KEEP_BATCH=1 yo test ./tests/collections/deque.test.yo
ls -a tests/collections | grep yo_selftest_batch   # the batch .yo, .bin.c, …
```

## Root cause

`src/main.yo`'s test-argument loop matches `--keep-generated-files` / `-k` and only advances the cursor; no variable records it. The cleanup after a batch tests `proc_env.get("YO_KEEP_BATCH")` alone.

## Fix

Either make `-k` set the same keep flag the cleanup reads (`YO_KEEP_BATCH` or the flag), or delete the option and its two help lines (en, zh-CN), leaving the environment variable the help already lists. Test: a cli-case that runs `yo test <file> -k` and records the kept batch files in `expected_tree`; it fails today.
