# `yo test --std-path` fails every batch under `YO_TEST_IN_PROCESS=1`

**Severity:** S3. A developer knob (`YO_TEST_IN_PROCESS`, never used in CI)
fails loudly. No wrong result is produced.

## Symptom

```bash
YO_TEST_IN_PROCESS=1 YO_TEST_MAX_RSS_MB=12000 yo test ./tests/internal --std-path ./std --parallel 1
```

This exits immediately with `yo: error: compile: unknown option '--std-path'`.
The same command without `YO_TEST_IN_PROCESS` works.

## Root cause

`--std-path` and `--imports` are global flags. `main` strips them from argv
before dispatching to a subcommand. The test runner forwards both to each
batch's `compile` argv so that a CHILD compile sees them
(`issues/fixed/yo-test-does-not-forward-std-path-to-batch-compile.md`).

The in-process runner does not spawn a child. It calls `run_compile` on that
argv directly, past main's stripping, so `compile`'s own option parser meets
`--std-path` and rejects it.

## Fix

`src/main.yo` forwards `--std-path` and `--imports` only to a child compile.
An in-process batch compiles against the runner's own module manager, which
already holds both overrides.

## Test

`tests/cli-cases/test-std-path-in-process` runs `yo test --std-path
$REPO_ROOT/std` with `YO_TEST_IN_PROCESS=1` and `YO_STD` pointed at a
directory that does not exist. Before the fix, the batch fails with the
unknown-option error. After it, the test passes against the flag's std.
