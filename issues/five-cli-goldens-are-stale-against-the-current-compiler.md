# Five CLI goldens are stale against the current compiler (watch, forward-ref, and three LSP cases)

**Status: OPEN.** Found 2026-09-17 on PR #755's full battery (run
`35245990956`, job "Self-hosted `test` subcommand (yo-self tier-1 gates)",
GATE 7): `CLIDIFF_RC=1  PASS 145  GOLDEN-DIFF 5`. Reproduced **identically on
a pristine `origin/develop` checkout at `054badf38`** with the same binary
(`YO_SELF_BIN=$(which yo) scripts/cli-diff-test.sh <the five cases>` →
`PASS 0  GOLDEN-DIFF 5`), so it is pre-existing at that tip and NOT caused by
#755 (docs-only). The develop push run for that tip was cancelled by the
concurrency rule before reaching this job, so the PR battery was the first
full run to surface it.

## The five cases (all rc=0, stdout diffs)

- `check-watch-once`
- `check-forward-ref-async-body`
- `lsp-analysis-resilience`
- `lsp-completion`
- `lsp-member-definition`

Two clusters: the `check-watch-once` / `check-forward-ref-async-body` pair
smells of the recently merged watch/evaluator work (#747's in-process watch
semantics, the forward-ref forcing), and the three `lsp-*` cases of LSP
output drift (completion lists / member definitions changed shape). All five
RUN green (rc=0) — the recorded goldens no longer match what the compiler now
prints.

## What to do

For each case: diff the golden against the current output and decide which
side is right BEFORE re-recording — a golden is a claim, and
`scripts/cli-diff-test.sh --record` on a wrong answer just pins it. If the
new output is correct (intentional behavior change from #747 or the LSP
work), re-record with a commit message naming the PR that changed the
behavior. If not, it is a live regression and the case is doing its job.

Do NOT bulk `--record` these in a docs PR.

Related: the same run's GATE 3 failed for a different, pre-existing reason —
[`tier1-check-std-now-requires-a-z3-solver.md`](tier1-check-std-now-requires-a-z3-solver.md).
