# CI flake episodes: nondeterministic job failures across all platforms

**Severity:** S3

## What was observed (2026-10-07)

Two distinct episodes on 2026-10-07 in which many unrelated jobs failed with
bare `Process completed with exit code 1.` and no error text, on content that
provably passed the same jobs before or after:

1. **~07:30Z**: the `Self-hosted test subcommand (yo-self tier-1 gates)` job
   failed at 36–57 minutes on three independently-developed wave-2 PRs
   (#1253, #1254, #1255) simultaneously; all three passed the same job on the
   one-rerun policy. A local `gates_fast.sh` reproduction on each branch
   reached gate 7 of 7 with zero failures — no content defect existed.
2. **~09:05–10:25Z**: PR #1261 (a docs-only diff: two markdown edits and one
   shell-script tolerance line) had nine jobs fail across every platform —
   `test (ubuntu-latest)`, `test (ubuntu-24.04-arm)`, both WASM jobs,
   `Compiler build inside 8 GB`, the tier-1 gates, the hollow sweep, and two
   shards — while `test (ubuntu-latest)` had PASSED on develop's own battery
   of the identical tree (`7e328a541`, run `37593871898`) an hour earlier,
   and the only step exercising the diff (`tree-hygiene`) passed. The rerun
   was cancelled by the PR's merge before it could confirm.

## Evidence

- The passing/failing sets for the same tree sha contradict determinism:
  develop@`7e328a541` run `37593871898` — `test (ubuntu-latest)` green;
  #1261 (same tree + docs) run `37598157586` — `test (ubuntu-latest)` red,
  failing step `Check the formatted code`.
- `gh run view --log-failed` for episode 2 shows only
  `##[error]Process completed with exit code 1.` for every failed step, and
  several log lines associate with `UNKNOWN STEP` — a log-pipeline symptom
  rather than a build/test symptom.
- githubstatus.com reported no active incident at the time (the Oct 5
  Actions/runners incident, 47% run failures, was resolved; runner image
  `ubuntu-24.04 20261004.327.1` appears in the logs of both episodes).

## Hypotheses

- Runner-image rollout `20261004.327.1` interacting with the toolchain setup
  (the Node-20→24 forcing warning appears in every log) or with the seed
  download step.
- Per-repo runner oversubscription during the day's heavy parallel batteries
  (five full batteries concurrently at times) causing resource-induced
  exit-1s that scatter across whatever jobs are long-running.

## What to do

Treat platform-scattered bare-exit-1 failures on a diff that cannot plausibly
cause them (docs, plans, single scripts) as suspect-infra first: rerun failed
jobs once before investigating content. If a third episode occurs, capture the
failing jobs' full logs immediately (they expire), and compare the runner
image version and the seed-install step timing between passing and failing
runs of the same sha.
