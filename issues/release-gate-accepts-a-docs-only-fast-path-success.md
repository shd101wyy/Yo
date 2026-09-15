# The release guard accepts a docs-only fast-path "success" as proof the code was tested

**Status:** open (found 2026-09-10 while cutting v0.2.30). **Merged 2026-09-14**
with the independent earlier filing of the same defect,
`issues/retired/release-gate-accepts-a-docs-fast-path-run-as-proof-of-green.md`
(2026-09-06, found while cutting v0.2.26) — its unique evidence and its
concrete query shape are folded in below.

## What the guard does

`.github/workflows/release.yml` refuses to release a commit whose Test workflow
is not green:

```
::error::Refusing to release $SHA — the Test workflow is '$CONCLUSION', not 'success'.
```

That is the right instinct, and it fired correctly on the first attempt (the
Test run was still in progress).

## The hole

`test.yml` has a **docs-only fast path**: a `changes` job classifies the diff
and, when no code changed, every real job is `skipped` — suite, bootstrap
fixpoint, hollow sweep, wasm32 (both), ThreadSanitizer, formal verification,
the self-hosted gates, the cross-emitted native suites.

A workflow run whose jobs are all `skipped` concludes **`success`**. So the
guard's `CONCLUSION == 'success'` test passes on a run that verified nothing
about the code.

Measured on `develop` at `5a160e373` ("plans: v0.2.30 release notes draft"),
17 jobs, of which the only non-skipped ones were the diff classifier, the VS
Code extension package, and the docs-site build:

```
Classify the diff (docs-only fast path)   success
VS Code extension (package + dry-run)     success
Documentation website (build only)        success
test-wasm32_wasi                          skipped
ThreadSanitizer (sync primitives)         skipped
Build the suite candidate (Linux)         skipped
Formal verification (pinned Z3)           skipped
Static musl Linux bundle                  skipped
Full-corpus hollow sweep                  skipped
test-wasm32_emscripten                    skipped
Self-hosted `test` subcommand             skipped
Bootstrap fixpoint (yo-self self-compile) skipped
...
```

## Why it is not merely theoretical

Concurrency cancellation compounds it. A merge train cancels each in-flight
`develop` run when the next merge lands, so the runs immediately before a
docs-only commit are often `cancelled`, not `success`:

| SHA | conclusion | what it was |
| --- | --- | --- |
| `5a160e373` | success | **docs-only fast path — nothing ran** |
| `95bc2493a` | cancelled | #522, superseded |
| `e1d7ff094` | cancelled | #532, superseded |
| `0319bce7c` | success | #526 — the last genuinely-full run |

So on 2026-09-10 the newest commit with a real green Test run was three commits
behind `develop`, and the release guard would still have let a release proceed
at `5a160e373` because a run that skipped everything reported success.

Ending a merge train with a docs commit — a release-notes PR, say, which is
exactly what a release does — is the normal way to land in this state.

## Suggested fixes

1. **Have the guard require a run that actually tested code.** The `changes`
   job already publishes its classification; the guard can read the run's job
   list and refuse when the gating jobs are `skipped`, or read the `changes`
   output directly. Refuse rather than warn: this is the last gate before
   publishing.
2. **Or walk back to the newest commit with a non-fast-path green run** and
   refuse if that commit is not an ancestor of the release SHA with only
   docs-classified commits in between. More faithful, more code.
3. Independently: the fast path could report `neutral` rather than `success`
   when it skips everything, which makes "nothing was verified" visible to any
   consumer rather than only to the release guard.

Option 1 is the small one and closes the hole.

## Workaround used for v0.2.30

Re-ran the cancelled full Test run on `95bc2493a` — `develop`'s head minus one
markdown file — and confirmed it genuinely green before triggering the release.

---

## Folded in from the 2026-09-06 duplicate filing

The same hole was found independently four days earlier, cutting v0.2.26. Two
things it carried that are not above:

**An earlier measurement, on a different commit.** `develop` at `fcd25ee66`
(the merge of the docs-only #455):

```
34025793623  fcd25ee66  completed  success   09:50:59 -> 09:54:36
jobs: skipped=13 success=3
```

Three and a half minutes, thirteen jobs skipped, conclusion `success`. So the
defect is reproducible across releases, not a property of the v0.2.30 window:
two independent sessions hit it on two different commits four days apart, each
while doing the ordinary thing.

**The query shape for fix option 1**, which is what makes it the small fix:

```bash
gh api "repos/$REPO/actions/runs/$RUN_ID/jobs" \
  --jq '[.jobs[] | select(.name | startswith("test (")) | .conclusion] | unique'
```

The release workflow already knows how to look at individual jobs, so this is
the same query shape it uses elsewhere — assert the gating `test (…)` jobs
concluded `success` rather than `skipped`, and walk back to the most recent run
that did if the newest is a fast path.

**Also cross-referenced there:** `plans/backlog/SEED_VERSION_AUTOMATION.md`
covers the other release-time consistency guard, and the two want doing
together — both are "the release trusts something that did not verify what it
appears to".

### Why this was filed twice, and what it costs

Neither session searched `issues/` before filing. That is the second duplicate
pair found in the 2026-09-14 clean-up (the first was IPv6 RFC 5952, filed
2026-09-04 and 2026-09-11). The pattern is the same: a defect hit while doing a
routine task gets written up from the angle of that task, and the title differs
enough that the earlier filing does not surface.

The cost is not just the duplicated writing — it is that **neither copy
accumulates the evidence**. Here, one copy had the concurrency-cancellation
table and three candidate fixes, the other had a second independent measurement
and the query to implement the chosen fix. Whoever picked up either one alone
would have started with half of what was known. `issues/TRIAGE.md` exists partly
so this is cheaper to notice next time.

### Still relevant as of 2026-09-14

Unfixed, and the surrounding practice has hardened around it instead:
`AGENTS.md` now carries three CI-run rules whose entire purpose is to stop a
human walking into this (never merge docs-only while a battery you need is in
flight; cancel superseded runs but check the newer tip is not a fast path; and
re-run the code-directory diff before tagging). Those rules are good, but they
are guidance a person must remember, and the guard is a check a machine
performs. The guard should still be fixed.
