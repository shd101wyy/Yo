# The release guard accepts a docs-only fast-path "success" as proof the code was tested

**Status:** open (found 2026-09-10 while cutting v0.2.30).

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
