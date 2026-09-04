# Seed auto-bump push rejected: RELEASE_PAT lacks the Workflows permission (GH013)

**Found:** 2026-08-21/22, on the v0.2.15 release — the FIRST live firing of
the release-time SEED_VERSION auto-bump (#200,
`plans/backlog/SEED_VERSION_AUTOMATION.md`).

## Symptom

`publish-release` flipped v0.2.15 public (all 13 assets), then its final
step — pushing the `ci: bump SEED_VERSION to v0.2.15` commit to develop —
was rejected:

```
remote: error: GH013: Repository rule violations found for refs/heads/develop.
remote: - refusing to allow a Personal Access Token to create or update
         workflow `.github/workflows/fixpoint-arm64.yml` without `workflow` scope
```

Two knock-on effects:

1. The seed bump never landed (pins stayed at v0.2.14).
2. Because the bump ran as a TAIL STEP of `publish-release`, its failure
   marked the whole job `failure`, and `deploy-site` (`needs:
   publish-release`) was **skipped** — the docs site kept advertising
   v0.2.14. The run is unsalvageable: reruns execute the original workflow
   snapshot, and the rerun path died at the Publish step ("no draft release
   found" — the draft was already public).

## Root cause

The seed-bump commit modifies `.github/workflows/*` — GitHub refuses such a
push from ANY token that does not carry the workflow permission. RELEASE_PAT
was created fine-grained with **Contents: read/write only** (sufficient for
the version-bump push, which touches no workflow files). The dry-runs
validated the sed and the guard, but nothing could exercise the PAT's scope
before the real push.

## Fixes

- **Workflow side (branch `ci/release-tail-hardening`):**
  - The seed bump moved to its OWN `seed-bump` job (`needs: [release,
    publish-release]`) so a bump failure can never take `deploy-site` down
    again.
  - The Publish step is idempotent on rerun (already-published tag ⇒
    continue, not error).
  - New `deploy-site.yml` manual workflow (`workflow_dispatch`, input:
    release tag) — rebuilds the site from the tag with that release's own
    compiler and deploys it; used to publish v0.2.15's site.
  - The v0.2.14→v0.2.15 pin bump rides the same PR (manual completion of
    what the auto-bump could not push; the PR's CI validates the v0.2.15
    seed pre-merge, same as #200 did for v0.2.14).
- **PAT side (USER ACTION, still open):** regenerate/edit `RELEASE_PAT`
  (fine-grained) to carry **both** "Contents: read and write" **and**
  "Workflows: read and write". Until then the `seed-bump` job will keep
  failing (now harmlessly) on every release.

Move this to `issues/fixed/` once a release's `seed-bump` job has pushed
successfully with the updated PAT.

---

**FIXED 2026-08-22:** the v0.2.16 release run (32568953170) — "Bump
SEED_VERSION on develop: success" — pushed e04a118c3 directly to develop,
updating the SEED_VERSION lines in all three workflow files. The
RELEASE_PAT now carries "Workflows: read and write".
