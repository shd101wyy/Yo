# The FV job runs Generation A test files with the seed

**Severity:** S2. Develop's battery was red, which blocked the v0.2.65 release. No compiler behavior was wrong.

**Status:** fixed 2026-10-18 by `fix/develop-verifier-test-d47`.

## Symptom

Develop battery run 39087983359 on `00eddd3e4` (#1440) failed one job: "Formal verification (pinned Z3)", at the step "Verifier unit tests (real solver)". The same job passed on `29ceb209d`. Reproduced locally with the v0.2.64 seed and the job's environment (`YO_STD`, `YO_TEST_Z3=1`):

```
error: Invalid binding to "mut", expected identifier or operator
yo: error: test: ./tests/internal/verifier.test.yo — 0 of 29 tests in this batch ran: the batch failed to compile
```

## Root cause

The `verify` job ran its five `yo test ./tests/internal/verifier*.test.yo` steps with the seed compiler. #1440 is decision 47 step 2 Generation A: E0917 applies outside `src/` and `std/`, so its sweep marked those files' written locals as `mut(cfg) := …`. In v0.2.64, `mut(x)` is the deleted borrow word, so the seed cannot parse the files.

The markers cannot be reverted. Every other job runs `tests/internal` on the tree compiler, which would then reject the same files with E0917. A tests/internal file is written in the tree's syntax, so only a tree compiler can run it.

The gate missed this because #1440's Tier 1 ran every changed test file with the tree binary. Nothing in Tier 1 runs the seed over `tests/`.

## Fix

- The `verify` job now needs `stage1`, and its five `yo test` steps run `/tmp/yo-stage1 test …`, the pattern `compiler-internal-tests-selfhosted` uses.
- The `yo verify` steps stay on the seed, because their inputs (`std/spec`, `std/collections`, `tests/spec`) carry no new syntax.
- AGENTS.md's Tier 1 list now says to run seed-run `yo test` steps with the seed when a change gives `tests/` new syntax.

## Test

The FV job is the test. Before the fix it fails on `00eddd3e4`. After the fix the five files pass on the tree compiler with the pinned Z3: run locally with `~/Workspace/Yo-wt/bins/yo-d47loc-3d1afa693` (the merged tree's src/std, `YO_TEST_Z3=1`), then on the PR's battery.
