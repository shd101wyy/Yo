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
dropping the std exemption (`plans/reference/MACRO_POLICY.md`), and allowing
paren-less prefix calls inside `src/`/`std/`
(`plans/reference/PREFIX_OPERATOR_OPERAND_RULE.md`) — each unlocks only once a
release CONTAINING those features becomes the seed, i.e. typically the
bump after next.

**Added 2026-08-25, DONE 2026-08-28** (collapsed once v0.2.18 became the seed;
verified by compiling a probe AND building the whole tree with the real v0.2.18
bundle, both rc=0, and `tests/time/sleep.test.yo` 4/4): collapse
`std/time/sleep.yo`'s `sleep_blocking` to its
natural one-expression body,
`__yo_ms_sleep(usize(duration.as_millis()))`. It is written as a two-statement
body only because the seed predates the codegen fix in
`issues/fixed/inline-builtin-alias-drops-body-arguments.md` and miscompiles the
one-expression form. Unlike the three above, this one fails LOUDLY if attempted
early — the seed's output makes clang report `invalid operands to binary
expression ('__yo_t1035' (aka Duration) and 'int')` — so it is safe to just try
it at each bump. Only `std/` and `src/` are gated; `tests/` are compiled by the
stage-1 built from the tree, which already carries the fix.

## Status addendum (2026-08-22)

Landed in #200; guard live in test.yml's `changes` job. The auto-bump's
FIRST live firing (v0.2.15 release) was rejected — GH013: `RELEASE_PAT`
lacked the fine-grained "Workflows: read and write" permission, which any
push touching `.github/workflows/` requires — and, because the bump ran as
a tail step of `publish-release`, the failure also skipped `deploy-site`.
Full record: `issues/fixed/release-seed-bump-needs-workflow-scope-pat.md`.
Hardening (branch `ci/release-tail-hardening`): bump moved to its own
`seed-bump` job, Publish made rerun-idempotent, manual `deploy-site.yml`
lever added, v0.2.14→v0.2.15 pins bumped manually via PR. Remaining USER
ACTION: add the Workflows permission to `RELEASE_PAT`.

## ~~Seed-gated follow-up (2026-08-27): migrate the compiler off `std/sys/bufio`~~ **DONE 2026-08-28**

Landed once v0.2.18 became the seed — that release carries #299 (the
nullable-ptr match shadow-registration fix), so `yo build` no longer mis-emits
`std/io/bufio`'s match bindings. **Verify the gate before assuming it, the way
this one was**: download the actual seed bundle and compile the module with it
(`yo compile` a two-line probe importing `std/io/bufio`) — the pre-#299 seed
fails with `use of undeclared identifier '_..._priv_temp_N'`.

`src/lsp/transport.yo`, `src/lsp/server.yo` and `src/check_watch.yo` now read
stdin through `BufReader(Stdin)`; `std/sys/bufio` and its 25-test file are
deleted. Note the API shape changed with the move: the fd reader returned
`Result(Option(T), Error)` and the generic one throws through `IoExn`, so the
consumers shed their `.Ok/.Err` arms — and `BufWriter(W)` regained
`write_string`/`write_bytes`, which only the deleted fd writer had.

## Seed-gated follow-up (2026-09-05): forward references in `std/`/`src/` — P5 of LAZY_TOPLEVEL_BINDINGS

Order-independent `::` definitions and `impl` registrations landed in develop on
2026-09-05 (#427 P1/P2, #435 P3). `std/` and `src/` may use them only once a
release carrying those PRs is `SEED_VERSION` — a pre-feature seed fails the build
with `Variable "X" not found` / `forward reference to "X"`. The P5 PR
(`feat/lazy-bindings-p5-lift-seed-gate`) lifts the rule text and makes the first
two uses in `src/` (`module_manager.yo`'s demand-loader slot and
`evaluator/types/synthesizer.yo`'s global function pointer become direct
references); it is verified locally with a stage-1 built by a feature-carrying
compiler + `fixpoint_only.sh`, and merges after the bump. **Verify the gate the
usual way before merging**: `yo build` the tree with the actual seed bundle.

## Seed-gated follow-up (2026-08-27): `Command.current_dir`

**Generation A DONE 2026-08-28:** the runtime emits
`__yo_async_spawn_start_cwd(file, argv, envp, stdin, stdout, stderr, cwd)` on
all platforms (posix `posix_spawn_file_actions_addchdir_np`, weak-linked so an
older libc reports ENOSYS; Windows `CreateProcessW` lpCurrentDirectory; wasm
stub) and the 6-argument `__yo_async_spawn_start` std declares is a wrapper
passing NULL. Proven by tests/process/command.test.yo under the fresh binary.
**Generation B (once `SEED_VERSION` ≥ the release carrying this):** declare
`__yo_async_spawn_start_cwd` in std/sys/externs.yo, make `std/sys/process.spawn`
take `cwd : ?(*(u8))`, add `Command.current_dir(path)` + a test through the
public API; then delete the 6-argument wrapper in a later generation.

- **Hasher defaults (D3.9, 2026-08-28):** `std/hash.yo`'s `SipHasher13` spells
  out every `write_*` because the v0.2.19 seed miscompiles `inout(self)` trait
  defaults (C43, issues/fixed/trait-default-inout-self-bound-by-value.md) and
  the compiler's own maps run this hasher. Once the seed carries C43 the
  overrides are an optimisation only — nothing to collapse, but a NEW std
  hasher may then rely on the defaults. Failure mode if violated: SILENT (the
  built compiler hangs in `__yo_main_module_init`).

- **`HashMapError.KeyNotFound` / `HashSetError.ElementNotFound` deletion (§6,
  2026-08-29):** dead by design (lookups return `Option`), but removing them
  makes the two enums structurally identical, which the v0.2.19 seed conflates
  (issues/fixed/structurally-identical-error-enums-in-two-generic-impls-collide.md,
  fixed in the tree). `src/codegen/chunk_assembly.yo` imports BOTH collections,
  so `yo build` under that seed would hit the collision. Apply the trim once
  the seed carries the fix; failure mode if early: LOUD (`Type mismatch for
  type member "error"` in `HashSet._resize`).
