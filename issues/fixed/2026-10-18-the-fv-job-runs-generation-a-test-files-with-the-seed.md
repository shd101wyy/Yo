# #1440's locals rule broke four develop CI jobs: seed-run test files, inline probes and a test-embedded program

**Severity:** S2. Develop's battery was red, which blocked the v0.2.65 release. No compiler behavior was wrong.

**Status:** fixed 2026-10-18 by `fix/develop-verifier-test-d47`.

## Symptom

Develop battery run 39087983359 on `00eddd3e4` (#1440) failed four jobs. The first is "Formal verification (pinned Z3)", at the step "Verifier unit tests (real solver)". The same job passed on `29ceb209d`. Reproduced locally with the v0.2.64 seed and the job's environment (`YO_STD`, `YO_TEST_Z3=1`):

```
error: Invalid binding to "mut", expected identifier or operator
yo: error: test: ./tests/internal/verifier.test.yo — 0 of 29 tests in this batch ran: the batch failed to compile
```

The other three are E0917 from a tree-built compiler on Yo source that #1440's sweep never saw:
- **"Static musl Linux bundle"**: `scripts/bootstrap/probe-stack-sizing.sh` writes a probe whose `local := n; … bump(&mut local)` is now E0917.
- **"Docker default-seccomp epoll fallback"**: the inline probe in `test.yml` calls `sv_uninit.as_ptr()` and `b_uninit.as_ptr()`, both `&mut self` receivers on unmarked bindings.
- **"Compiler internal tests, self-hosted differential shard 5"**: `tests/internal/compile.test.yo`'s "a value enum's drop and dup are one function each" writes a fixture program from a string literal, and `(k : usize) = usize(0); … k = (k + usize(1))` is E0917.

## Root cause

The `verify` job ran its five `yo test ./tests/internal/verifier*.test.yo` steps with the seed compiler. #1440 is decision 47 step 2 Generation A: E0917 applies outside `src/` and `std/`, so its sweep marked those files' written locals as `mut(cfg) := …`. In v0.2.64, `mut(x)` is the deleted borrow word, so the seed cannot parse the files.

The markers cannot be reverted. Every other job runs `tests/internal` on the tree compiler, which would then reject the same files with E0917. A tests/internal file is written in the tree's syntax, so only a tree compiler can run it.

The gate missed all four:
- #1440's Tier 1 ran every changed test file with the tree binary, and nothing in Tier 1 runs the seed over `tests/`.
- `yo fix --migrate mut-bindings` rewrites `.yo` files only. A program inside a shell here-document or a workflow `run:` block, or inside a test's string literal, is invisible to it.
- The string-literal fixture is compiled by a `yo` subprocess found on `PATH`. Locally that was the v0.2.64 seed, which does not enforce the locals rule, so the test passed. CI's self-hosted shard puts stage 1 on `PATH`.

## Fix

- The `verify` job now needs `stage1`, and its five `yo test` steps run `/tmp/yo-stage1 test …`, the pattern `compiler-internal-tests-selfhosted` uses.
- The `yo verify` steps stay on the seed, because their inputs (`std/spec`, `std/collections`, `tests/spec`) carry no new syntax.
- The two probes and the fixture mark their written locals (`mut(local)`, `mut(sv_uninit)`, `mut(b_uninit)`, `mut(k)`, `mut(i)`). All three are compiled only by tree-built binaries.
- A sweep found no other hit. It extracted all 124 multi-line Yo programs embedded in `tests/` string literals and checked each with the tree compiler. Only one other program reports E0917, in `tests/internal/formatter.test.yo`, and that one is only ever formatted, never compiled. `scripts/check-embedded-yo.sh` (the installer and release smoke programs) passes 7 of 7 sites with the tree compiler.
- AGENTS.md's Tier 1 list now covers all three places for a change that alters what parses or type-checks.

## Test

The four CI jobs are the tests. Before the fix, all four fail on `00eddd3e4`. After the fix the five files pass on the tree compiler with the pinned Z3: run locally with `~/Workspace/Yo-wt/bins/yo-d47loc-3d1afa693` (the merged tree's src/std, `YO_TEST_Z3=1`), then on the PR's battery.
