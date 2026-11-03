# The self-hosted differential shards were striped by name, not by duration

**Severity:** S3: CI plumbing. Develop's battery goes red with every test
passing. Shard 0 is killed at the job timeout mid-file, so `Merge gate (all
checks)` fails, and a release cut (which needs a green run on the exact tip)
waits for a rerun that can time out again.

**Status: FIXED 2026-11-03.** Files are assigned to shards by measured
duration (`scripts/bootstrap/differential_shard.sh`, weights in
`scripts/bootstrap/differential-shard-weights.tsv`).

## What happened

`Compiler internal tests (tests/internal, self-hosted differential shard N)`
runs a sixth of `tests/internal` under the seed-built stage-1, one file at a
time, with `timeout-minutes: 150`. On develop battery 41506787582 (c60934bcb,
2026-11-02) shard 0 ran from 19:41Z to 22:11Z and was cut off mid-file in its
verifier files. Every file before that point passed. The two green batteries
before it show how far apart the shards were:

| develop run | s0 | s1 | s2 | s3 | s4 | s5 |
| --- | --- | --- | --- | --- | --- | --- |
| 41337442878 (dc24349c5) | 143 min | 66 | 75 | 35 | 45 | 109 |
| 41472964105 (36945db9c) | 143 min | 44 | 83 | 70 | 24 | 114 |
| 41506787582 (c60934bcb) | **timed out at 150** | 86 | 82 | 63 | 46 | 95 |

This is the same failure class as
`issues/fixed/the-self-hosted-differential-shards-outgrew-their-150-minute-budget.md`.
That fix moved from 4 to 6 shards. It kept the selection the retired TS arm
used, though: the heavy quote/reflection files went one per shard and the
rest were striped round-robin over the sorted glob.

## Root cause

Round-robin striping balances the number of files on each shard, not their
running time. Per-file times in this tier range from 0.1 to 30 minutes. The
slow files are a few compiler-sized ones plus about twenty verifier files
(10-14 min each). Which shard they land on depends only on where they fall
in alphabetical order. Shard 0 drew `lsp_protocol` (29.6 min), `compile`
(22.0), `module_prelude_outcome` (12.5), the `ast_reflection` heavy (9.7) and
four verifier files (`verifier_assumed`, `verifier_list_len`,
`verifier_refine`, `verifier_twostate`, 11.7-13.5 each), about 143 minutes in
all. Shard 5 drew `module_invalidation` (20.0), `diagnostics_registry_examples`,
`recursive_enum`, `type_trait_methods` and four more verifier files, about 110
minutes. Shard 4 drew 25-46 minutes. The three "heavy" pins (9.7-10.3 min
each) are no longer the heaviest files in the tier, so pinning them did not
help.

The per-file times (the `::group::<file>` block's start to its
`::endgroup::`) also show that runner speed varies by up to 2x between jobs
of ONE battery: `verifier_ghost` took 13.1, 6.5 and 11.6 minutes on the three
runs. Shard 0's 143 minutes came on two slow runners, and on the third
battery it went past 150.

## Fix

`scripts/bootstrap/differential_shard.sh <shard> <count>` prints one shard's
files. The assignment is longest-processing-time first: the files are sorted
by weight (heaviest first, ties broken by path), and each goes onto the shard
with the least predicted time so far. The weights are a checked-in table,
`scripts/bootstrap/differential-shard-weights.tsv`. Each entry is the SLOWEST
of the measured samples from the three batteries above (108 files, about 545
minutes in total). A file missing from the table gets a 10-minute default and
a `::warning::`. `--table <count>` prints every shard with its predicted
minutes, so the map can be checked locally. The workflow step calls the script
without a pipe, so a failing selection fails the job instead of running an
empty, green shard.

Predicted time per shard, using the slowest samples: 90.8, 90.8, 90.8, 90.8,
90.7 and 90.7 minutes, down from a range of 25-143 minutes. The timeout stays
at 150 as the hang guard, which leaves about 60 minutes of margin even on slow
runners. If the tier grows past about 110 minutes a shard, the next step is
more shards (8 would predict about 68 minutes each), not a longer timeout.

The ruleset needs no change. Its only required check is `Merge gate (all
checks)`, which `needs:` the job by id (`compiler-internal-tests-selfhosted`),
not by shard name.

## Test

- `scripts/bootstrap/differential_shard.sh --table 6`: each shard gets 18
  files, and the six lists partition the 108 files with no duplicates.
- gawk and mawk (the ubuntu runner's `awk`) give byte-identical output.
- A dry run of the workflow step (extracted from the parsed YAML, with the
  test command replaced by `echo`) selects 18 files on every shard. With the
  weight table removed, the dry run fails with rc 2.
- The battery is the real test. The PR's run and the next develop run must
  show six shards that each finish well under 150 minutes.
