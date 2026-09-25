# An emcc test batch passes without running a test

**Found:** 2026-09-26, reproducing `emscripten-threads-created-off-the-main-thread-are-never-reclaimed.md`
locally: `yo test tests/thread.test.yo --c-compiler emcc` reported the 5000-iteration nested-thread
test as passed with the v0.2.43 seed, while the same loop compiled as a program aborted with
`Aborted(OOM)`. The batch had run in 0.04 s.
**Status:** FIXED 2026-09-26. **Class:** hollow gate (a test reported as passed that never ran).

## Repro

```sh
yo test tests/thread.test.yo --c-compiler emcc      # emcc 4.0.12: every test "passes"
YO_KEEP_BATCH=1 yo test ... ; YO_TEST_INDEX=0 node tests/.yo_selftest_batch_1_0.js   # returns at once
```

A program that prints `env.get("YO_TEST_INDEX")` prints `NONE` under emcc 4.0.12 and node.

## Cause

The runner compiles a file's tests into one batch program and selects the test to run with the
`YO_TEST_INDEX` environment variable (`src/main.yo`). The batch's `main` matched on it with two
silent fallbacks: `.None => ()` when the variable is unset, and `true => ()` for an index with
no arm. emcc 4.0.12's node glue does not forward `process.env` to the program (its
`getEnvStrings` builds only the default entries). So every emcc batch took `.None`, returned 0
and was counted as passed. CI's emsdk 6.0.6 does forward it, which is why the CI leg ran its tests.

## Fix

Both fallbacks panic, naming the problem: "YO_TEST_INDEX is not set (this runtime did not
forward the environment), so no test ran", and "YO_TEST_INDEX names no test in this batch". A
runner and batch that disagree now fail, and never pass with nothing run.

## Regression test

Running any test file with `--c-compiler emcc` under emcc 4.0.12 now fails every test with the
first message, where it used to pass them all.
