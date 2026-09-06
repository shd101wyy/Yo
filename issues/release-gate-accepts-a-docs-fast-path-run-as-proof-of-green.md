# The release gate accepts a docs fast-path run as proof of a green suite

**Status: OPEN** (filed 2026-09-06). Found while preparing v0.2.26.

## Symptom

`.github/workflows/release.yml`'s "Require a green test run for this commit"
step refuses to release unless the Test workflow CONCLUDED SUCCESSFULLY for
the SHA being released:

```bash
CONCLUSION=$(gh api "…/workflows/test.yml/runs?head_sha=$SHA&status=completed" \
  --jq '[.workflow_runs[] | select(.conclusion != null)] | first | .conclusion // "none"')
[[ "$CONCLUSION" != "success" ]] && exit 1
```

The step's own comment explains the intent: the workflow publishes to npm and
the VS Code Marketplace, both irreversible, so "a red develop was
publishable" had to be made impossible.

But `success` is not the same as *ran*. A docs-only push takes test.yml's fast
path, which SKIPS the required contexts. develop at `fcd25ee66` — the merge of
the docs-only #455 — has exactly such a run:

```
34025793623  fcd25ee66  completed  success   09:50:59 -> 09:54:36
jobs: skipped=13 success=3
```

Three and a half minutes, thirteen jobs skipped, conclusion `success`. The
gate accepts it. So **any release cut from a SHA whose last commit was
docs-only is gated on a run that compiled and tested nothing** — the exact
hole the step was written to close, reachable through the ordinary and
frequent act of merging a docs PR last.

## Consequence in practice

It does not mean such a release is broken — the code content was validated on
the PRs, and a docs-only delta cannot change the binary. It means the gate
stops being evidence, silently, based on the shape of the final commit. A real
red could ride in under it if the docs commit lands after a code commit whose
own run was cancelled (which is routine: merges cancel each other's develop
runs via the concurrency group).

## Fix

Require the run to have actually exercised the suite, not merely concluded
`success` — e.g. assert that the required `test (…)` jobs in the chosen run
have conclusion `success` rather than `skipped`, and walk back to the most
recent run that did if the newest one is a fast path. The release workflow
already knows how to look at individual jobs; the same query shape works:

```bash
gh api "repos/$REPO/actions/runs/$RUN_ID/jobs" \
  --jq '[.jobs[] | select(.name | startswith("test (")) | .conclusion] | unique'
```

Related: `plans/backlog/SEED_VERSION_AUTOMATION.md` covers the other
release-time consistency guard.
