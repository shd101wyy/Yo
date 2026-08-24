# S1 prelude growth TRIPLED self-emit peak memory (10 → 29 GB) — 16 GB CI runners swap-thrash, differential shards time out

**Status: OPEN (mitigated in CI; root fix is the env-sharing campaign).**
Found 2026-08-24 when PR #243's differential shards died at the 120-min
budget even UNCONTENDED, after the S1 chunks merged. This is the
`plans/backlog/YO_SELF_ENV_SHARING.md` pathology hitting its predicted
wall: def-time body envs COPY what TS shared, so every prelude
fn/impl/method added costs a copy of an ever-BIGGER prelude frame —
super-linear growth in both memory and time.

## Measurements (seed v0.2.16, `yo compile src/main.yo --release
--skip-c-compiler`, macOS M4; "peak" = `/usr/bin/time -l` peak memory
footprint — see the footprint-metric memory note for why not RSS)

| tree | wall | peak footprint |
|---|---|---|
| 644bf2120 (pre-#238, last green shards) | 67 s | 10.0 GB |
| 7a1a24bb7 (+ S0 #238, chunk 1 #240, chunk 2 #241) | 138 s | 17.4 GB |
| 9c31ec0f0 (+ chunk 3 #242, #239) | 390 s | 29.2 GB |

Cumulative — no single culprit PR. The evaluator-only path is UNCHANGED
(`yo check tests/internal/ast_reflection.test.yo`: 60 s old vs 57 s new) —
`check` never evaluates fn bodies, so it never pays the def-eval copies;
full compile does.

## CI impact

- The 4 differential shards (16 GB ubuntu runners + 32 G swapfile): the
  seed stage-1 `yo build` went 12.8 min (green, 2026-08-23) → **60.5 min**
  (swap thrash), and the heavy internal files then trip the test-runner's
  DEFAULT 600 s `--compile-timeout-ms` (ast_reflection, build_runner —
  "Yo compilation exceeded the configured time limit"), so shards fail or
  hit `timeout-minutes: 120`. Every required shard check on develop is
  currently un-passable. (The first #243 failures looked like the known
  two-matrices starvation; the uncontended rerun disproved that.)
- The other stage-1-building jobs (fixpoint, tier-1 gates, hollow sweep,
  musl bundle) run 1.2–2 h but pass — bigger budgets, no per-file deadline.

## Mitigation (this change)

`test.yml` differential-shard job: `timeout-minutes` 120 → 210 and
`--compile-timeout-ms 1800000` on the per-file test invocation. This is a
BUDGET patch, not a fix — shard wall time is ~2–2.5 h until the root
lands, and every future prelude addition makes it worse. REVERT both knobs
when the env-sharing fix lands.

## Root fix

`plans/backlog/YO_SELF_ENV_SHARING.md` — the ranked levers for sharing
def-time body envs instead of copying (frozen frame membership is the
prerequisite, see the campaign memory notes). The S1/S2 std campaign is
BLOCKED-ish on it: chunk 4 (ranges, +570 prelude lines) and chunk 6
(IntoIterator) are validated locally and will push the peak further; S3+
additions compound it. Sequence the env-sharing work BEFORE landing more
prelude surface.
