# A test batch that fails to compile aborts the whole `yo test` run

**Severity:** S2: one file whose batch cannot compile hides every file after
it. The run still exits nonzero, but the files it never reached report
nothing, so their regressions stay invisible until the first one is fixed.

**Status:** fixed 2026-10-02.

## What

`yo test` compiles each file's tests as a batch and runs them. When the batch
compile failed, the runner threw. That ended the whole run: no later batch,
no later file, no summary. Measured 2026-10-02, while gating the safe-mode PRs
on develop `7d04eb24d`: the local fast suite ran 82 of 305 files.
`tests/dyn.test.yo`'s batch failed to compile on duplicate vtable structs,
which yo-88 is fixing separately, and the other 223 files never ran.

## Fix

`src/main.yo`, the batch loop of the test subcommand. A failed batch now:
- prints the same `0 of N tests in this batch ran: the batch failed to
  compile …` line, to stderr;
- reports each of its tests as failed (`✗ <name>` plus `the batch failed to
  compile; this test did not run`, or a failed `test` event under `--json`),
  so they count in the summary;
- skips running that batch;
- stops the run only under `--bail`.

The run then continues with the next batch and the next file. Its exit code
is still nonzero, so the hollow-batch protection the throw gave (§1.2 of
`plans/archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md`) is kept: a compile
failure can never read as a pass.

## Test

`tests/cli-cases/test-batch-compile-failure-continues`. In `a_broken.test.yo`,
an extern names a C symbol nothing defines, so its batch fails to link.
`b_fine.test.yo` must still run and pass, and the summary must read 1 passed,
1 failed, rc 1. Before the fix the run stopped after `a_broken` and
`b_fine` never ran.
