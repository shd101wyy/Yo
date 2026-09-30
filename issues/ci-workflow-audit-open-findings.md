# CI workflow audit (2026-09-29): the findings not fixed in the audit PR

**Severity:** S2 — a failing `changes` job skips every required check, so a PR can merge with its SEED_VERSION guard red, and several required jobs test a binary the release does not ship

Found by an audit of `.github/workflows/*.yml` and `.github/actions/*` at
develop `2914215b0`, plus `actionlint` 1.7.12 with shellcheck (no structural
findings; the shellcheck warnings are intentional `$(pkg-config …)`
splitting). The audit PR (branch `ci/pr-base-develop-and-audit`) fixed:
- the pull_request base filter (#848 revived);
- the docs-site generator, which now uses the tree's stage-1;
- `pipefail` on the verify and portable-C pipes;
- the `--strict` laws gate;
- the bare `apt-get` in I/O budgets;
- the unused `pull-requests: write`;
- the missing timeouts;
- release and Pages concurrency;
- the release gate's develop-push filter;
- stale comments.

What is below needs a settings change, a CI-validated restructuring, or a
decision. Line numbers are as of `2914215b0`.

## Open, by severity

1. **S2: a failing `changes` job makes the PR mergeable.**
   - `changes` ("Classify the diff (docs-only fast path)") is not among the
     20 required contexts of ruleset 13548862. Every required job `needs:`
     it. When it fails, the dependents are skipped, and a skipped required
     check satisfies the ruleset (test.yml says so itself near line 1292).
   - `changes` hosts the SEED_VERSION consistency guard, whose job is to
     fail. So the guard's failure is exactly what lets the PR through.
   - Fix, either of:
     - add `Classify the diff (docs-only fast path)` to the ruleset (a
       repository-settings change);
     - add one required aggregate job (`if: always()`, `needs:` every job)
       that fails unless each result is `success` or an intended `skipped`.
2. **S2: the per-PR musl rehearsal tests gen-1; the release ships gen-2.**
   test.yml's musl job has the seed emit the C directly (around line 2351).
   The release re-emits with that binary (release.yml ~1062, "the shipped
   C"), gates on stage-3 byte identity (~1099) and runs a `yo build run`
   smoke (~1200) that gen-1 bundles once hung on. None of those steps is
   rehearsed per PR, and linux-arm64-musl has no rehearsal at all. Fix:
   `needs: stage1`, emit the shipped C with `yo-stage1`, and add the stage-3
   `cmp` and the `yo build run` smoke.
3. **S2: the required tier-1 gate runs about 77 `build` cli-cases on gen-1.**
   test.yml ~2060 runs `S1=/tmp/yo-stage1 … gates_fast.sh`, whose GATE 7
   drives `tests/cli-cases` (54 `build run`, 15 `build`, …) through
   stage-1's own build runner.
   `issues/fixed/build-smoke-hangs-registry-perturbation.md` says the
   verification binary must be gen-2. Fix: GATE 7 on stage-2, from the
   fixpoint job's artifact or built once in `stage1`.
4. **S3: stage-1 and stage-2 are rebuilt about 9 times per battery.**
   - On x64 that is 5 stage-1 builds (the `stage1` job, `test`,
     suite-candidate, and the two wasm legs) and 4 stage-2 builds (`test`,
     suite-candidate, fixpoint, emscripten).
   - `build-stage1/action.yml` says the migration onto the shared artifact
     "was never done".
   - The memory-split workaround in the `test` job (~861) is justified by
     a seed limitation fixed in v0.2.43
     (`issues/fixed/compiler-holds-emit-memory-during-cc.md`).
   - Fix: `needs: stage1` plus the artifact everywhere except the arm64
     leg; plain `yo build --std-path ./std`.
5. **S3: PR CI cross-emits with stage-2, while the release cross-emits with
   stage-1** (test.yml ~1102 vs release.yml ~592). Either this costs 15–30
   minutes of redundant critical path, or PR CI validates C the release
   does not ship. Fix: the same candidate as the release.
6. **S3: the `yo test` runner is gen-1** in hollow-sweep, tsan, the internal
   shards, epoll-corpus and ubsan. The test binaries themselves are
   tree-emitted; the runner's own async code is the seed's.
7. **S3: the release can be dispatched from a branch other than develop.**
   The Marketplace step's `dryRun` keys on `github.ref`, but the checkout is
   pinned to develop. A dispatch from another branch therefore still bumps,
   tags, publishes and deploys. Fix: an early step that fails unless
   `github.ref == 'refs/heads/develop'`, if dispatching elsewhere is never
   intended.
8. **S3: `install-scripts.yml` `tee` pipes lack pipefail** (~133, run under
   `sh -euc`). Before adding it, check that the Alpine `sh` (busybox ash)
   accepts `set -o pipefail`.
9. **S3: the vscode-extension dry run receives `VS_MARKETPLACE_TOKEN`**
   (test.yml ~350), and the global `vsce` install (~338) is unused. Check
   whether the dry run needs the token at all.
10. **S3: `choco install llvm -y` is unpinned** (test.yml ~1374,
    release.yml ~708), while the comments name fixed clang versions.
11. **S3: seed installs used only for `install-deps`** in several jobs
    (these could pass the stage-1), and `fmt --check` runs twice (test.yml
    ~986 and `gates_fast.sh`).
