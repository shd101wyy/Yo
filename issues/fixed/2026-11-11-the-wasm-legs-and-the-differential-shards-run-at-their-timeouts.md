# The wasm legs and the differential shards run at their timeouts

**Severity:** S3. This is CI plumbing. On a green tree, develop batteries have run the Emscripten leg within 1-3 minutes of its cap and have cancelled it at the cap, so `merge-gate` reports red and a release battery gives no verdict.

**Status: FIXED** on `fix/ci-split-wasm-differential`. Found 2026-11-10 on develop `30e1411cd`.

## Symptom

Job minutes on develop `test.yml` batteries (`gh api repos/:owner/:repo/actions/runs/<id>/attempts/1/jobs`). The runs are 42605340282 (`3ff5d6f05`), 42708865105 (`fe58873dd`), 42737388741 (`983a05e69`, before #1876) and 42783395167 (`30e1411cd`, with #1876's R-PROBE lookups).

| Job (cap) | 42605340282, green | 42708865105 | 42737388741 | 42783395167 |
| --- | --- | --- | --- | --- |
| `test-wasm32_emscripten` (150) | 149 | 91 | 147 | cancelled at 150 |
| `test-wasm32_wasi` (120) | 69 | 110 | 66 | cancelled at 120 |
| differential, 6 shards (150) | 105-130 | 66-130 | 100-130 | 92-140, one shard cancelled at 150 |

Nothing failed in the cancelled jobs. The first three batteries predate #1876, so the timeouts are not only R-PROBE: Emscripten sat at 147-149 of 150 on two green batteries. The differential job's own comment says to add shards once a shard outgrows about 110 minutes, and five of six shards were above that. `differential_shard.sh --table 6` predicts 90.8 minutes a shard, so the measured weights are about 30% stale.

## Cause

The evaluator keeps getting slower on its own source during VBD, and a hosted runner's speed varies by up to about 1.5x. Both wasm legs ran the whole `tests/` suite in one job, and the differential tier compiled the compiler once per file on six shards, so none had margin left.

## Fix

Raising the caps again would turn each of these into a 2.5-3 hour job on every battery. Instead:

- `test-wasm32_emscripten` and `test-wasm32_wasi` become two-leg matrices (`shard: [0, 1]`, `fail-fast: false`), and the test step gains `--shard ${{ matrix.shard }}/2`. The runner stripes the sorted file list, as `test-native` already uses it, so the shards partition the suite. Caps stay 150 and 120.
- On Emscripten, the stage-2 build exists only for the build-system smoke test (the tests run on stage-1), so both steps run only on shard 0. Each leg still builds stage-1 because its tests need it. Neither leg uploads an artifact, so no artifact name can collide.
- The differential tier goes from 6 to 8 shards (`differential_shard.sh "$shard" 8`). `--table 8` predicts 68.0-68.1 minutes a shard, about 90 real at today's drift. The cap stays 150, and the job comment's "6-way" paragraph says why.

`merge-gate` lists job ids in `needs:`, so matrix legs need no edit there and the ruleset (whose one required check is `merge-gate`) needs no change. No other workflow or script names these jobs.

Any of these legs above 75% of its cap after the split is a new issue. (Emscripten shard 0 was: `issues/fixed/2026-11-11-emscripten-shard-0-runs-at-82-percent-of-its-cap.md`.)

Test: CI plumbing only. The next develop battery shows each leg's verdict and duration.
