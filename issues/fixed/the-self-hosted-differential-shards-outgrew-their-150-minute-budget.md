# The self-hosted differential shards outgrew their 150-minute budget

**Severity:** S2 — develop's battery goes red with every test passing: shard 0
is killed at the job timeout mid-file, so `Merge gate (all checks)` fails and a
release cut (which needs a green run on the exact tip) waits two and a half
hours for a rerun that can time out again.

**Status: FIXED 2026-10-13** — the job is sharded 6-way instead of 4-way
(`.github/workflows/test.yml`, `compiler-internal-tests-selfhosted`).

## What happened

`Compiler internal tests (tests/internal, self-hosted differential shard N)`
runs a quarter of `tests/internal` under the seed-built stage-1, one file at a
time, with `timeout-minutes: 150`. The tier kept growing into that budget:

| develop run | shard 0 | shard 1 | shard 2 | shard 3 |
| --- | --- | --- | --- | --- |
| 38145374346 (2026-10-11) | 104 min | 111 min | 146 min | 70 min |
| 38208297731 (2026-10-12) | 144 min | 107 min | 143 min | 102 min |
| 38262413827 (2026-10-12) | timed out, then 128 min on rerun | 100 min | 129 min | 104 min |
| 38333980990 (2026-10-13, c2fe7d0e1) | **timed out at 150 min** | 121 min | 126 min | 112 min |

Both timeouts cut shard 0 off in its run of five verifier files
(`verifier_generics` … `verifier_twostate`, about 12–13 minutes each) with
every earlier file passing. The 150-minute limit was sized in 2026-09 to give
the heaviest shard about 30% margin over 113 minutes; three of four shards now
run above 120.

## Fix

Six shards, the same selection: the four heavy macro/reflection files go one
per shard (shards 0–3; 4 and 5 get none), the rest stripe round-robin over the
sorted glob. Using run 38333980990's per-file times, the estimated test time
per shard drops from 112–163 minutes to 63–93 minutes, before the ~10 minutes
of setup each job pays. The timeout stays at 150 so a hang is still caught.

The ruleset needs no change: its one required check is `Merge gate (all
checks)`, which `needs:` the job by id, not by shard name.

## Test

The battery is the test: develop's next run must show six differential shards,
each well under the limit. Before the fix, shard 0 timed out on run
38333980990; after it, the PR's own battery and the develop run on its merge
commit record the six durations.
