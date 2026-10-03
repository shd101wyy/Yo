# SEED_VERSION: consistency guard + release-time auto-bump PR

**Status:** BACKLOG (agreed with maintainer 2026-08-21). Scheduled as the
follow-up branch after the closed-operator-set / prefix-operand-rule PR
lands.

## Problem

`SEED_VERSION` (the previous-release bootstrap root) is hand-duplicated in
FOUR workflows — `test.yml`, `release.yml`, `fixpoint-arm64.yml`, `ubsan.yml` (added 2026-09-28) — each
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

## DONE (2026-10-01): delete `ArrayList.set_len`

`issues/fixed/safe-code-reaches-freed-memory-through-arraylist-set-len.md` (S1).
This turned out NOT to be seed-gated. `markdown_yo` v0.0.9 removed its
`set_len` calls by switching to `extend_from_ptr` and `truncate`, not to the
token API. So the compiler bumped the dependency to `^0.0.9` and deleted
`set_len` in the same change that added `spare_capacity` + `assume_init`.

## Seed-gated follow-up (2026-10-01): `ArrayList.push` states its elements

**Generation A DONE 2026-10-01** (`feat/verifier-for-produced`,
`issues/fixed/a-quantified-ensures-is-spliced-as-a-runtime-assert.md`): the
compiler splices only a runtime-checkable `ensures`; a clause that quantifies
or calls a `ghost_fn` is proof-only. Measured with the v0.2.48 seed: the seed
splices every `ensures` of a non-verify-target module, so a `forall` in
std's `push` makes every program that pushes fail with `ghost-only builtin`
(`YO_STD=<tree>/std yo compile` of a three-line `push` program). The CI jobs
that compile with the seed and the tree's std (the FV job, the seed-with-tree-std
build) would all go red. So `push` keeps only its length clause, and the
fixtures that need its elements (`dml_append_seq`, `dml_sorted_insert`,
`for_produced`, `lemma_member_frame` and their twins) call a local `assumed()`
`push_at_end` that states them. A verify target's own `ensures` is not
spliced by the seed.

**Generation B DONE** (`feat/push-element-contract`, once SEED_VERSION is
v0.2.49): `push`'s `ensures` carries
`forall(k : usize, (k < self.len()) ==> (self(k) == cond((k == old(self.len())) => value, true => old(self)(k))))`.
The fixtures' `push_at_end` wrappers are gone (back to `out.push(x)`), and
`docs/*/FORMAL_VERIFICATION.md` §Sequences over lists no longer says "until
the seed".

## Seed-gated follow-up (2026-09-30): `build.verify` in `std/build.yo`

**Generation A DONE 2026-09-30** (issues/fixed/verify-by-default-for-a-project.md):
the compiler carries `__yo_build_verify(name, root, mode, strict)` — a
`BuildVerifyConfig` in the build registry, a `Verify` DAG node, and
`run_verify_step` in `src/build_runner.yo`, which runs `yo verify <root>
--verify-mode <mode> [--strict]` in the child the way a test suite runs
`yo test`. `std/build.yo` gained only the seed-safe `StepKind.Verification`
variant; a build file calls the builtin directly and wraps the Step itself —
cli-case `build-verify-dry-run`, docs `docs/*/BUILD_SYSTEM.md` § Verification
steps.

**Generation B DONE 2026-10-01** (SEED_VERSION v0.2.47 carries the builtin): the
wrapper below is in `std/build.yo`, and the cli-case, both `BUILD_SYSTEM.md` and the
workflow cheatsheet use `build.verify`. The original instruction was: add the
friendly wrapper to `std/build.yo` after `export(doc);` — it was written and
parked here because the seed evaluates `std/build.yo` and fails E0401 on the
unknown builtin (measured 2026-09-30 with v0.2.46: every wrapper shape fails,
a plain body included):

```rust
// ── Verification ─────────────────────────────────────────────────────
/// The mode a `build.verify` step runs its target files in (the same two
/// modes `Pragma.Verify` / `Pragma.VerifyOrAssert` select per file, see
/// docs/en-US/FORMAL_VERIFICATION.md §Modes).
VerifyMode :: enum(
  /// `verify`: every obligation must be proved; a refuted, unproven or
  /// outside-subset contracted function fails the step.
  Verify,
  /// `verify+`: a refutation fails the step; an unproven obligation keeps its
  /// runtime assert and warns.
  VerifyOrAssert
);
export(VerifyMode);
/// Configuration for a verification step.
VerifyConfig :: struct(
  /// Step name (e.g., "verify").
  name : comptime_str,
  /// Root source file or directory to verify (every `.yo` file under it).
  root : comptime_str,
  /// Verification mode (default: `Verify`).
  (mode : VerifyMode) ?= VerifyMode.Verify,
  /// Pass `--strict` (a vacuous `ok` with zero obligations fails, see
  /// docs/en-US/FORMAL_VERIFICATION.md §Strict mode).
  (strict : bool) ?= false
);
export(VerifyConfig);
/// Register a verification step: `yo build <name>` runs `yo verify <root>`
/// with the pinned Z3. Returns a Step for dependency wiring. This is the
/// project-level "every build proves my contracts" switch; `yo check` stays
/// solver-free by design.
///
/// ## Examples
///
/// ```yo
/// build :: import("std/build");
///
/// proofs :: build.verify({ name : "verify", root : "./src" });
///
/// install :: build.step("install", "Build all artifacts");
/// install.depend_on(proofs);
/// ```
verify :: (fn(comptime(config) : VerifyConfig) -> comptime(Step))({
  mode_str :: match(config.mode, .Verify => "verify", .VerifyOrAssert => "verify+");
  __yo_build_verify(config.name, config.root, mode_str, config.strict);
  Step(name : config.name, kind : StepKind.Verification)
});
export(verify);
```

Then point the cli-case fixture and both `BUILD_SYSTEM.md` at `build.verify`,
and drop the Generation-A paragraphs there and in the workflow cheatsheet.

## Seed-gated follow-up (2026-09-12): `build.manifest` in `std/build.yo`

**Generation A DONE 2026-09-12** (plans/archive/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md
§4.1): the compiler carries `__yo_build_manifest_field(field)`, a comptime
string builtin answering from the build registry's `manifest_fields`, which
`src/build_runner.yo` fills from the project's `yo.toml` `[package]` table
before it evaluates `build.yo` (`name`, `version`; an absent field and every
field outside a build read as `""`). A build file calls the builtin directly
today — cli-case `build-manifest`.

**Generation B (once `SEED_VERSION` ≥ the release carrying it):** `std/build.yo`
exposes the friendly spelling — a `Manifest` struct and a `manifest ::
Manifest(name : __yo_build_manifest_field("name"), …)` binding, so a build file
writes `build.manifest.name`. It CANNOT land earlier: a module-level `::`
binding is forced by its own `export(...)`, so an older seed fails
`std/build.yo` with `error[E0401]: Variable "__yo_build_manifest_field" not
found` — and `fixpoint-arm64.yml` bootstraps gen-1 with `yo build`, which
evaluates `std/build.yo` on every run. (The v0.2.30 seed does not even report
it: it still swallows build-file evaluation errors and prints `No build steps
defined.`) Verify the gate the usual way before merging: `yo build` the tree
with the actual seed bundle. The cli-case fixture then moves to
`build.manifest.<field>`, and the user docs (`docs/*/BUILD_SYSTEM.md`) document
it as the public surface.

## Seed-gated follow-up (2026-10-03): `JoinHandle.join` at the three hand-rolled wait loops

**Generation A DONE 2026-10-03** (`plans/ASYNC_IO_API_AUDIT.md` A1): the runtime
emits `__yo_join_wait_new` / `__yo_join_wait_add`, `std/async` declares them,
`JoinHandle.join(io)` and the future-shaped combinators are built on them, and
`tests/async/combinators.test.yo` proves them from inside a task under the
tree binary. **Generation B (once `SEED_VERSION` ≥ the release carrying the
primitive):** replace the `is_finished()` + awaited `yield` loops with
`io.await(h.join(io), io)` / `io.await(timeout(...), io)` at
`std/http/client.yo` (`_fetch_deadline`, on the compiler's import path through
`src/version_cache.yo` and `src/verifier/z3.yo`), `std/process/command.yo`
(`output`'s stderr drain) and `src/build_runner.yo` (the scheduler's wait).
Failure mode if early: LOUD — the seed's runtime has no `__yo_join_wait_new`,
so stage 1 fails to link.

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

- **`__yo_build_doc`'s dead `include_deps` slot (B13, 2026-09-12):**
  `DocConfig.include_deps` was write-only and is gone from `std/build.yo`, but
  the call still passes a literal `false` in argument slot 5 because the seed's
  `__yo_build_doc` requires ten arguments. Once `SEED_VERSION` carries the
  nine-argument builtin, drop the literal from `std/build.yo` and the slot from
  `evaluate_yo_build_functions`. Failure mode if early: LOUD (`build.doc`
  reports too few arguments while the seed evaluates the build file).

- **`TestSuite.verbose/bail/parallel` (B13, 2026-09-12):** `std/build.yo` passes
  seven arguments to `__yo_build_test`; `_build_require_args` is a MINIMUM
  check, so the seed's four-argument builtin ignores the extra three and the
  suite simply runs with the old hard-coded defaults under a seed build.
  Nothing to schedule — recorded so the silent degradation is not mistaken for
  a regression when a seed-built binary runs `build test`.

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
