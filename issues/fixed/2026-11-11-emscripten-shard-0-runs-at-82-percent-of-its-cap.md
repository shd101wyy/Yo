# The Emscripten shard 0 leg ran at 82% of its cap after the 2-way split

**Severity:** S3 (CI only: a slow hosted runner cancels the leg on variance alone, and the battery has no wasm verdict)

**Filed:** 2026-11-11. **Fixed:** the same day.

## Symptom

The 2-way split (`issues/fixed/2026-11-11-the-wasm-legs-and-the-differential-shards-run-at-their-timeouts.md`) says a leg that stays above 75% of its cap is a new issue. Battery 42865362929 (develop `26a422d55`, the first one after the split) measured:

| Leg | Minutes | Cap | Share |
| --- | --- | --- | --- |
| emscripten shard 0 | 123 | 150 | 82% |
| emscripten shard 1 | 93 | 150 | 62% |
| wasi shard 0 / 1 | 85 / 86 | 120 | 71% / 72% |
| differential shards 0-7 | 62-93 | 150 | at most 62% |
| FV harness / list-model | 78 / 72 | 180 | at most 43% |

## Cause

Shard 0 also ran the stage-2 build (24 min) and the build-system smoke test, on top of the stage-1 build (53 min) and its half of the tests (43 min). The step timings come from the job's own steps.

## Fix

The smoke work moves to its own matrix leg, `shard: [0, 1, smoke]`.

- The `smoke` leg builds stage-1 and stage-2 and runs the smoke test. It runs no tests, so it takes about 77 min (51%).
- Legs 0 and 1 run only `--shard i/2` of the tests, about 96 min each (64%).

The job's display name reads `build-system smoke` for the new leg. `merge-gate` lists job ids, so it needs no edit.

Test: CI plumbing only. The next develop battery shows each leg's verdict and duration.
