# SEED_VERSION: consistency guard + release-time auto-bump PR

**Status:** BACKLOG (agreed with maintainer 2026-08-21). Scheduled as the
follow-up branch after the closed-operator-set / prefix-operand-rule PR
lands.

## Problem

`SEED_VERSION` (the previous-release bootstrap root) is hand-duplicated in
THREE workflows — `test.yml`, `release.yml`, `fixpoint-arm64.yml` — each
with a copy of the same justification comment. Divergence would silently
split the trust chain (PRs validated against one seed, release artifacts
built from another). Bumping is manual and lags: v0.2.14 is published but
the seed still says v0.2.13.

(Third question from the same discussion — "deploy Pages only after
artifacts attach" — is ALREADY implemented: `deploy-site` needs
`publish-release`, which needs every artifact job; see the deliberate
comment at release.yml:1166.)

## Plan

1. **Consistency guard** (a STEP in an existing early `test.yml` job, not
   a new job — the branch-protection required-checks list is manual and a
   new job would need a hand-edit there): grep the three workflows'
   `SEED_VERSION:` lines, fail on mismatch. Consolidate the 15-line
   justification comment into one file (test.yml), point the others at it.
2. **Release-time direct bump push** (maintainer decision 2026-08-21,
   revising the earlier bot-PR draft): `publish-release` ends by pushing a
   commit to `develop` with `RELEASE_PAT` that bumps `SEED_VERSION` to the
   just-published tag in all three files — the same mechanism and trust
   level as the existing `chore: bump version ... [skip ci]` pushes.
   Rationale: the bump runs only after the ENTIRE release pipeline
   succeeded (every artifact job green), so the marginal protection of a
   human-merged PR was small, and the bot-PR flow adds PAT/trigger
   friction. Two safeguards: the bump commit must NOT carry `[skip ci]`
   (the push immediately exercises the new seed on develop; a bad seed is
   a visible red + a one-line revert), and it pushes only from
   `publish-release`'s success path. Rejected alternatives: a bot PR
   (friction without much added safety — the v0.2.9 memory-cliff class
   would pass a PR gate anyway); an Actions repo variable (seed changes
   would bypass review entirely).
3. **First payload**: the bump v0.2.13 → v0.2.14 rides this branch if
   v0.2.14's bundle matrix checks out.

## Choreography note

The seed bump commit is the natural scheduling point for the
generation-gated follow-ups recorded elsewhere: deleting the prelude `if`
macro + its export, std self-declaring `pragma(Pragma.AllowMacroDef)` and
dropping the std exemption (`plans/MACRO_POLICY.md`), and allowing
paren-less prefix calls inside `src/`/`std/`
(`plans/PREFIX_OPERATOR_OPERAND_RULE.md`) — each unlocks only once a
release CONTAINING those features becomes the seed, i.e. typically the
bump after next.
