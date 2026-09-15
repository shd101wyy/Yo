# Building with seed v0.2.33 breaks two async-channel tests on clean develop

OPEN (2026-09-15). Surfaced while re-running the fast suite for the Phase-4
gate PRs (#692/#693) after installing seed v0.2.33 locally.

## The bisect (clean, reproducible)

| compiler build | `yo test tests/async/channel.test.yo` |
| --- | --- |
| develop `6403cbf4a`, built with seed **v0.2.32** | green (2657/2658 whole fast suite, the 1 being the known nix-TMPDIR artifact) |
| develop `6403cbf4a`, built with seed **v0.2.33** | **2 failures** (below) |
| PR #692/#693 branch, built with seed v0.2.33 | the same 2 failures |

So the regression comes from the SEED SWAP alone — the v0.2.33 seed
transpiles the tree's std/async channel code (or its evaluator paths)
differently than v0.2.32, and the difference breaks real behavior. Not
caused by any open PR.

## Failing tests (all repro on clean develop + v0.2.33)

- `tests/async/channel.test.yo`: `async: dropping the last Sender resolves
  a SUSPENDED recv as Disconnected`; `Test channel Stream combinators`.
- `tests/async/combinators.test.yo`: `Test join_all with aborted member`;
  `Test race picks the fastest`; `Test any skips aborted handles` (and
  possibly more across `tests/async/` — the whole abort/wake area is
  suspect; everything outside `tests/async/` that the suite reached before
  `--bail` passed).

## What this blocks

- **Bumping CI's `SEED_VERSION` to v0.2.33** (`.github/workflows/test.yml`,
  `fixpoint-arm64.yml`) would make every CI leg build with a seed that fails
  these tests. The release manager should hold the bump until this is fixed.
- Locally, anyone who installs v0.2.33 and rebuilds will hit the same two
  failures.

## Reproduce

```bash
# with seed v0.2.33 at ~/.local/bin/yo
yo build
yo test tests/async/channel.test.yo --parallel 1   # 2 failures
```

## Next step for whoever fixes it

Diff the emitted C for `tests/async/channel.test.yo` (or a minimal
sender-drop/recv-suspend fixture) between a v0.2.32-seeded build and a
v0.2.33-seeded build of the same tree (`yo compile ... --emit-c
--skip-c-compiler` with each seed), focusing on the suspended-recv wake path
in `std/async`'s channel implementation and the async state machine's
`cond_branch` handling. The failing assert is about a SUSPENDED recv
resolving to Disconnected when the last Sender drops — so the wake-on-close
path is the prime suspect.
