# The self-hosted differential CI job needs sharding, not a bigger timeout

**Status: OPEN** (filed 2026-08-15 while unblocking PR #122's merge train.)

## Why

`compiler-internal-tests-selfhosted` (.github/workflows/test.yml) runs the
WHOLE `tests/internal` tier under one self-hosted binary in one job:

```
/tmp/yo-stage1 test ./tests/internal --parallel 1 --verbose
```

Its budget has already been raised once, from 90 to 180 minutes, because:

- on develop it took **88m50s of a 90-minute budget** (run 31708389473 —
  70 seconds of headroom) while the self-hosted test binaries were still
  UNinstrumented, and
- P2.5 step 4 gave the self-hosted runner TS's default `--sanitize address`,
  so every batch binary is now ASan-instrumented — paying instrumentation
  cost in both the compile and the run of a compiler-sized program.

A timeout raise buys time; it does not fix the shape. The tier only grows
(59 files on develop, 60 now), and each of the four heavy macro/reflection
files compiles the whole evaluator at ~6.5 GB peak.

## What to do

Shard it 4-way exactly as the TS arm was sharded on 2026-08-06
(test.yml:496 `matrix: shard: [0, 1, 2, 3]`), reusing that step's proven
selection logic: the four heavy files go one per shard, the rest stripe
round-robin over the sorted glob. That took the TS arm to ~25-40 min per
shard and is the precedent this job should follow.

## Do this together with P2.5 step 20

`plans/P2_5_RETIRE_EXECUTION.md` step 20 **deletes the 4-shard TS arm**, making
this job the SOLE arm for `tests/internal` — which both raises the stakes (its
timeout becomes the only thing standing between a regression and an unscored
tier) and, crucially, carries the SAME branch-protection hazard described
below. Step 20 already says "Check branch protection first".

Two job-name changes, each needing a required-check update, is two chances to
block every PR. Ship them as ONE change: delete the TS shards and shard this
job in the same PR, with a single required-check list update covering both.

## The trap that makes this more than a YAML edit

Sharding RENAMES the job: one
`Compiler internal tests (tests/internal, self-hosted differential)`
becomes four `… self-hosted differential shard N` checks. Branch protection
on this repo lists its required checks MANUALLY (15 of them), so the rename
would leave a required check that can never run again — every PR would
block forever waiting for it. Any PR doing this must, in the same change:

1. add the four new job names to the required-check list, and
2. remove the old single name,

and the person merging must confirm the protection update landed BEFORE the
rename reaches develop. That ordering is the whole risk; the YAML is easy.

## Cheaper alternative if sharding is deferred

Keep one job but drop `--parallel 1`'s implicit whole-tier scope: split the
step into two invocations in the same job (heavies alone, the rest batched).
Same job name, so no branch-protection work — but it only halves the tail,
it does not parallelize across runners.
