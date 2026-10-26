# The test runner's 10-minute compile timeout no longer covers compile-test on a loaded box

**Severity:** S3 (tooling) — no compiler defect: batches that pass solo fail only under machine
load, wasting a battery round and reading as a flake.

**Status:** open (tooling). Filed 2026-10-26 by the coordinator after three false failures in one
day on the shared 64 GB WSL box.

## What happened

Three unrelated pieces today hit the test runner's default compile deadline purely under box
load (12 heavy-lock slots of concurrent builds/checks, load ~11+), and each passed when re-run
alone with a raised deadline:

- b12's `tests/internal/ast_reflection.test.yo` — timed out in a shared battery, passed solo
  with `--compile-timeout-ms 2400000`;
- b6-a / b4-1a's `tests/internal/compile.test.yo` — same shape, same solo pass with 2400000;
- p4's earlier `tests/internal/diagnostics_registry_examples.test.yo` — same shape.

The deadline is the child compile's cooperative deadline the test subcommand forwards
(`src/main.yo`, `--compile-timeout-ms`, default hardcoded at `600000` when the flag is absent).
That default was already outgrown once by the tree itself (the comment there records the
verifier battery at 651 s on the audit box, measured 2026-09-20); the three failures today show
the MARGIN is gone for ordinary internal batches too whenever the box is saturated: a 10-minute
budget for a batch that needs ~5 min of CPU at 12 concurrent heavy jobs is not a budget.

Precedent command (what unblocked all three):

```bash
yo test ./tests/internal/<file>.test.yo --std-path ./std --parallel 1 --compile-timeout-ms 2400000
```

## Recommendation

Either raise the default (e.g. `1800000` — a runaway comptime loop still fails in half an hour,
and a loaded-box batch fits), or keep `600000` but document the override in
`.github/instructions/testing.instructions.md` as the standard spelling for battery runs on a
loaded shared box (the heavy-lock policy already accepts that the box is routinely saturated).
The cheaper first step is the doc: today's failures cost three re-runs because nobody remembered
the flag exists. No code change in this PR (doc-only filing, rides with
`fix/develop-opseq-option-spill`).
