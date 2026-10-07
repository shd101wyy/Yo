# `yo test`'s ASan probe leaves its `.asan_probe.c` behind when the `cc` spawn fails

**Severity:** S3 — a scratch-file leftover on hosts without a `cc` executable; no wrong verdict, but it pollutes the test file's directory and any tree-comparison golden

**Found**: 2026-10-03, gating
`issues/fixed/leak-regression-tests-cannot-fail-in-ci-leak-verdicts-are-off-everywhere.md`'s
cli-case (`tests/cli-cases/test-needs-leak-verdict-skip`): the case's sandbox
tree carried `./.yo_selftest_batch_1_0.bin.asan_probe.c` after a GREEN run on
a Windows host whose Git Bash PATH has `clang` but no `cc`.
**Status**: OPEN.

## Symptom

```
$ YO_SELF_BIN=<tree yo> bash scripts/cli-diff-test.sh test-needs-leak-verdict-skip
── GOLDEN-DIFF  test-needs-leak-verdict-skip  (rc=0; tree)
    project tree:
      only-in-self:   ./.yo_selftest_batch_1_0.bin.asan_probe.c
```

The same file is left next to any `.test.yo` run on such a host (visible with
`YO_KEEP_BATCH=1` off, i.e. in the ordinary cleanup path).

## Root cause

`_asan_runtime_is_usable` (`src/main.yo:2499`) writes `${base}.asan_probe.c`
FIRST, then spawns `cc -fsanitize=address …` and cleans both artifacts up at
the END of the happy evaluation (`src/main.yo:2545-2548`). Every early exit is
an `unwind` through `probe_exn` (whose handler is just
`unwind(false)`), and the cleanup sits AFTER the throwing steps:

- `Command.new("cc").status(io)` THROWS when no `cc` executable resolves
  (this Windows host: `command -v cc` is empty) instead of returning a
  failure status — so the function unwinds at the spawn, before
  `remove_file(probe_src)` at `:2545` ever runs.
- The probe's verdict is still correct (`AddressSanitizer is not functional
  with this compiler setup … Skipping sanitizer`, `src/main.yo:4807`); only
  the cleanup is skipped.

The probe also hardcodes `cc` rather than the configured `--c-compiler`, so
on any `cc`-less host the sanitizer is probed unusable even when the chosen
compiler links ASan fine — a second, related gap (the probe result is cached
process-wide, `g_asan_usable`).

## Fix

Do the cleanup on the failure path too: bind `probe_src`/`probe_bin` before
the exception whose handler removes them (then `unwind(false)`), or fall back
to removing the artifacts at the top of the handler; and probe with the
configured C compiler when one was chosen.

## Why no red-first test yet

The leftover only reproduces where `cc` is absent; CI's Linux/macOS runners
all have `cc`, so a tree-clean cli-case there scores vacuously (the artifact
never exists), and gating it on a Windows-only leg pins a host property
rather than the code's. The honest interim record is this doc plus the
`ignore` glob in `tests/cli-cases/test-needs-leak-verdict-skip/ignore`, which
documents exactly which artifact is host-dependent.
