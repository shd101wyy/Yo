---
mode: agent
---

You are a programming language and compiler expert.

Detailed instructions for specific areas are in `.github/instructions/`. Always read and follow the relevant file before working in that area.

| Area                             | Instruction file                                     |
| -------------------------------- | ---------------------------------------------------- |
| C code generation                | `.github/instructions/c-codegen.instructions.md`     |
| Debugging evaluator / C output   | `.github/instructions/debugging.instructions.md`     |
| Running / writing tests          | `.github/instructions/testing.instructions.md`       |
| Yo language design & std library | `.github/instructions/yo-design.instructions.md`     |
| Yo syntax rules                  | `.github/instructions/yo-syntax.instructions.md`     |
| Documentation                    | `.github/instructions/documentation.instructions.md` |

## Reading historical documents

`plans/`, `issues/` and `code-reviews/` are historical records and are not rewritten. Translate as you read:

- `src/**.ts` (and `bun`, `package.json`, `./yo-cli`) is the **retired TypeScript compiler**, deleted 2026-08-20 and frozen at the git tag `src-attic-final`. `src/**.yo` is always the current compiler. The file extension disambiguates.
- `yo-self/` is today's `src/`; `yo-self/tests/` is today's `tests/internal/`; `./yo-cli <args>` is `yo <args>`; `src/tests/fixme.yo` is `tmp/fixme.yo`.
- `open(...)` is pre-2026-09-10 spelling: a glob import is `{ ... } :: import("m")`, a module value destructures as `{ a, b } :: SomeModule`, a struct as `{ x, y } := s` (`plans/reference/REMOVE_OPEN_BUILTIN.md`).
- `escape` is the old name of `unwind`; the `phase6*` test files were renamed to `quote_macro_eval`, `macro_expansion`, `ast_reflection`, `macro_helpers`.
- "yo-self" survives as a NAME in two REQUIRED CI check names ("Bootstrap fixpoint (yo-self self-compile)", "Self-hosted `test` subcommand (yo-self tier-1 gates)") and in artifact names like `/tmp/yo-self-bin`. Renaming those checks would block every PR; leave them alone.

---

## Architecture

The Yo compiler is **written in Yo**, lives in `src/`, and is self-hosting: the `yo` binary that compiles this tree was itself compiled from this tree. It compiles Yo to C11 and hands the C to a system C compiler:

```
Yo source → Lexer → Parser → AST (expr.yo)
                                  ↓
                             Evaluator   ← compile-time evaluation, type checking, CTFE
                                  ↓
                             Verifier    ← optional: Z3-backed contract proofs (src/verifier/)
                                  ↓
                             Codegen     ← emits C11 code
                                  ↓
                          C compiler (clang/gcc/zig)
```

Building it needs an existing `yo`: a **seed release** (the previous published version) or, with no binary at all, the published single-file `yo.c` (`scripts/make-portable-c.sh`). `scripts/install.sh` installs a bundle; `build.yo` at the repo root is how the compiler builds itself (`yo build`). Record: `plans/archive/BOOTSTRAPPING.md`.

### Key directories

| Path                              | Role                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`                            | The Yo compiler. `src/README.md` has the layout and test instructions                                                                                |
| `src/main.yo`                     | CLI entry point: argument parsing and subcommand dispatch                                                                                            |
| `src/lexer.yo`, `src/token.yo`, `src/parser.yo`, `src/expr.yo` | Tokens → AST; `expr.yo` holds the core node types and the builtin keyword constants                                                     |
| `src/expr_info.yo`                | `ExprInfo`: the per-expression annotation side table the evaluator fills in and codegen reads                                                        |
| `src/evaluator/`                  | Type checking, CTFE, trait resolution; `exprs/` per node, `calls/` specialization and dispatch, `effects/` algebraic-effects analysis, `builtins/`     |
| `src/verifier/`                   | The formal verifier: `terms.yo` (VC IR), `vc.yo` (symbolic walk), `encode.yo` (SMT-LIB 2), `z3.yo` (solver harness), `driver.yo`. Plan: `plans/backlog/FORMAL_VERIFICATION.md` |
| `src/codegen/`                    | C11 emission; `exprs/` per node, `async/` state machines + per-platform I/O runtimes, `functions/`, `parallelism/`, `c/allocator_fixed.yo` (TLSF allocator) |
| `src/emitter.yo`                  | The header / declaration / code buffers everything writes into                                                                                       |
| `src/types/`                      | Type values and compatibility helpers                                                                                                                |
| `src/module_manager.yo`           | "Evaluate a `.yo` file and read its exports": demand loader, cached prelude env, shared codegen `ExprInfoTable`, std-path resolution                  |
| `src/manifest.yo`, `src/resolver.yo`, `src/fetch.yo`, `src/lock_file.yo`, `src/cache.yo`, `src/install_command.yo`, `src/toml_edit.yo` | `yo.toml` / `yo.lock` v2 / the content-addressed store / `yo add\|remove\|install\|update` / `yo cache` |
| `src/build_runner.yo`             | `yo build`: the build DAG, its level-based scheduler, artifact compilation                                                                            |
| `src/formatter.yo`, `src/lsp/`, `src/doc/`, `src/doc_command.yo` | `yo fmt`, `yo lsp` (one module per feature), `yo doc`                                                                                    |
| `src/init.yo`, `src/skills_command.yo`, `src/cli_lang.yo`, `src/version.yo`, `src/version_cache.yo`, `src/pkg_config.yo`, `src/target.yo` | `yo init`, `yo skills install`, `--lang`/`YO_LANG` (en + zh-CN), `.yo-version`, release-bundle cache, pkg-config, target triples |
| `std/`                            | The standard library; `std/build.yo` is the build API; `std/spec/` the verification vocabulary                                                        |
| `tests/`                          | Language tests (`*.test.yo`); `tests/spec/` the verifier's; `tests/internal/` the compiler's own (heavy: each file compiles the compiler)              |
| `tests/cli-cases/`, `scripts/cli-diff-test.sh` | CLI subcommand goldens: each case runs in a sandbox (own project dir, own `HOME`) comparing rc + stdout + trees; `--record` writes goldens |
| `scripts/bootstrap/`              | Gate batteries: `gates_fast.sh`, `fixpoint_only.sh`, `hollow_sweep69.sh`, `known-failing.tsv`                                                        |
| `plans/`                          | Design docs. Root = active, `reference/` = landed decisions (authoritative), `backlog/` = written-not-started, `archive/` = closed. Index: `plans/README.md`; roadmap: `plans/ROADMAP.md` |
| `issues/`                         | Root = open bugs; `fixed/`, `retired/`, `repros/`, `patches/` (see `issues/README.md`)                                                               |
| `docs/en-US/`, `docs/zh-CN/`      | User docs, always in both languages                                                                                                                  |

### Design decisions you must know before writing Yo

One line each; the linked doc is authoritative.

- **No function overloading** (`plans/reference/FUNCTION_OVERLOADING_POLICY.md`); the prelude's operator pairs are the only exported multi-candidate `Call` tuples.
- **No operator precedence**: parenthesize every infix chain (`plans/reference/OPERATOR_SET_AND_PRECEDENCE.md`). `yo fmt` preserves parens.
- **Macros kept but gated**: definitions need `Pragma.AllowMacroDef`; `if(...)` is desugared to `cond(...)` at parse time (`plans/reference/MACRO_POLICY.md`).
- **`::` definitions and `impl` registration are order-independent within a module** (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`).
- **`--target` is the canonical Rust triple**, no aliases (`plans/reference/TARGET_TRIPLES.md`).
- **`--allocator fixed`** is a TLSF allocator over one static region sized by `--heap-size` (`plans/reference/FIXED_REGION_ALLOCATOR.md`).
- **Dependencies live in `yo.toml`, not `build.yo`**; `import("dep")` resolves through the nearest manifest in every command; only `yo build` fetches, so every other command needs `yo install` first on a fresh clone (`plans/archive/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`).
- **No runtime dependent types**; runtime properties go through the verifier (`plans/backlog/DEPENDENT_TYPES_POSITION.md`, `plans/backlog/FORMAL_VERIFICATION.md`).
- **`match` is being redesigned** (`plans/MATCH_PATTERN_MATCHING.md`, active): today value matching exists only on the primitive path.
- **No backward-compatibility scaffolding** (single user): no deprecation windows, aliases or shims; the only gate is the seed (`plans/backlog/SEED_VERSION_AUTOMATION.md`).

### Algebraic effects model

- `return(expr)` inside an effect handler **resumes** the continuation.
- `unwind(expr)` inside an effect handler **discards** the continuation and exits the enclosing `fn`. An unwound async task enters `FutureState.Aborted` (state = -2).
- C's `abort()` (process termination on panic) is a different thing. Never confuse the two.

### Async/await threading model

Yo's async/await is **single-threaded** (like C#): all I/O submissions and completions run on one event loop thread. Do not add mutexes or atomics to async runtime variables. The parallelism runtime (`src/codegen/parallelism/`) is a separate multi-threaded concern.

---

## Build & Test Commands

The compiler is the `yo` binary on your PATH (install with `scripts/install.sh`; on Windows `scripts/install.ps1`, where Git Bash needs `yo.cmd`).

```bash
yo build                      # build the compiler with itself → yo-out/<target>/bin/yo
yo check ./src                # type-check the whole compiler tree (evaluator-only) — run this FIRST
yo check ./std                # no solver needed: since #760 a missing Z3 is a skip-with-hint for `check` (it ships nothing) and stays a hard failure for `compile` (verify-mode binaries carry no runtime asserts). The FV CI job owns the proofs; `yo verify std/collections/array_list.yo` installs the pinned Z3 if you want them locally
yo compile src/main.yo --skip-c-compiler   # ~3 min; catches async state-machine rules `check` cannot see (they fire in codegen)

# Language tests. --parallel 1 for single files. Always save verbose output to a file.
yo test ./tests/algebraic_effects.test.yo --bail -v --parallel 1 &> output.txt
yo test ./tests/algebraic_effects.test.yo --test-name-pattern "Test fn unwind" --parallel 1

# Fast language suite (~30 min on a Mac Mini M4; mirrors CI). Both excludes matter:
# tests/internal compiles the compiler ~60 times; tests/cli-cases fixtures contain
# .test.yo harness inputs, one of which MUST fail — without the exclude ~4 false failures.
yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail

# std's own tests (sibling *.test.yo files + in-file test(...) declarations)
yo test ./std --bail

# Compiler-internal tests: ONE FILE AT A TIME (macro_expansion alone needs 6.5 GB;
# two concurrent children swap and trip the runner's 600 s deadline, manufacturing
# failures). The whole directory takes ~22 min.
yo test ./tests/internal/parser.test.yo --parallel 1

# Verifier
yo verify ./tests/spec --format json

# Self-hosted gate batteries (need a built binary in $S1)
S1=/tmp/yo-s1 P=local bash scripts/bootstrap/gates_fast.sh
S1=/tmp/yo-s1 P=local bash scripts/bootstrap/fixpoint_only.sh
BIN=/tmp/yo-s1 OUT=/tmp/hsweep bash scripts/bootstrap/hollow_sweep69.sh   # every language test through the self-hosted binary, ratcheted against scripts/bootstrap/known-failing.tsv

# Single-file iteration (tmp/fixme.yo is the scratch file; tmp* is gitignored)
yo check ./tmp/fixme.yo
yo compile tmp/fixme.yo --emit-c --skip-c-compiler --optimize 2      # inspect the C
yo compile tmp/fixme.yo --optimize 2 -o a.out && ./a.out
yo compile tmp/fixme.yo --optimize 2 --sanitize address --allocator system -o test && ./test
```

`yo compile` cannot be used on `*.test.yo` files: extract the failing case into a standalone `.yo` file with a `main` function and `export(main);`.

Build-system and CLI subsystems (`build_runner`, `fetch`, `lock_file`, `install_command`, `cache`, `init`, `version`, `pkg_config`, …) are tested under `tests/internal/`.

### Project commands

```bash
yo init [dir] --name my-project
yo build [run|test] [--list-steps] [-Dname=value]
yo doc ./std [-o dir] [--format html|markdown|json]
yo add user/repo[@^1.2] | yo add ./path      # declare + fetch a dependency in yo.toml
yo remove name | yo install [--locked|--offline] | yo update [name...] [--latest]
yo cache path|clean|gc
yo version [pin [X.Y.Z] | install X.Y.Z | list [--remote] | clean]
yo skills install                            # copy the bundled agent skills into the project
yo explain E0xxx | yo fix <path>             # diagnostics registry / structured repairs
```

---

## Workflow Rules

### Before, during, after a change

- **Use the LATEST published seed** (`yo --version` = newest GitHub release). A current tree can need runtime symbols only the newest seed emits. Update with `bash scripts/install.sh` (`--no-deps` on nix boxes).
- Run `yo check ./src` before any longer command. `check` is evaluator-only: async state-machine rules are enforced in codegen, so gate those with `yo compile src/main.yo --skip-c-compiler`.
- Make commands succeed yourself. Do not ask the user to run them, and do not end the conversation until they pass.
- No hardcoding, no shortcuts, no simplifications in the evaluator or codegen. When asked to refactor, refactor everything: no placeholders, no TODOs.
- Do not create new `.yo` files unless told to.
- Never skip a bug discovered during implementation. Every bug gets an `issues/` entry and a test that fails before the fix and passes after, added to `tests/`.
- **Run `yo fmt <file.yo>` on every `.yo` file you create or modify** (`yo fmt --check` verifies). There is no pre-commit hook.
- Review `git diff` before considering work done: leftover debug code, unused imports, consistency across files.
- After any change, check whether instruction files (`.github/instructions/`), skill files (`.github/skills/`), plans or docs need updating. **Whenever you learn something about Yo syntax, semantics or pitfalls by trial and error, update the cheatsheets and instruction files immediately.**
- Plans go in `plans/` (taxonomy in `plans/README.md`); bugs in `issues/` (taxonomy in `issues/README.md`). Docs under `docs/` are written in both `docs/en-US/` and `docs/zh-CN/`. Use ` ```rust ` for Yo code blocks in Markdown.
- There is no JavaScript runtime at the repo root. The one exception is `vscode-extension/`, a deliberate npm-only island (`npm ci`, `npm run package`).
- If you have not modified code, do not re-run commands.

### Git: worktrees, branches, merges

- **The main checkout `$HOME/Workspace/Yo` is shared with other sessions: never `checkout -b`, `pull`, `stash` or edit there.**
- **Worktrees live under `$HOME/Workspace/Yo-wt/<name>` (or another durable path), never under `/tmp` or `/private/tmp`** (macOS clears them on reboot; one reboot deleted 27 agents' uncommitted worktrees). Create with `git worktree add -b <branch> $HOME/Workspace/Yo-wt/<name> origin/develop`, then `git -c protocol.file.allow=always submodule update --init`. Remove with `git worktree remove --force <path>` (the `vendor/` submodules make plain `remove` refuse).
- **Commit and push before every heavy step.** WIP commits are fine (PRs are squash-merged); `git push -u origin <branch>` right after the first commit. A worktree is not a backup; only a pushed commit is.
- **Squash-merge and delete the branch**: `gh pr merge <n> --squash --delete-branch`. If `--delete-branch` errors (`used by worktree at ...` / `'<base>' is already used by worktree`), the REMOTE branch usually survives too: check with `git ls-remote --heads origin <name>` (empty = gone) and finish by hand with `git push origin --delete <name>`, `git worktree remove <path>`, `git branch -D <name>`.
- Set `GIT_TERMINAL_PROMPT=0` when running `git ls-remote` against possibly non-existent repos.

### CI runs: cancelling, freezing, and what a battery covers

Three views of one rule: the only question is "does the battery I am about to trust cover the code I am about to act on".

- **Cancel runs a merge made pointless.** A squash-merged branch's run gates nothing (its commit no longer exists on any branch), and a backlog of such runs has held every runner for hours. Keep every open PR's runs, the newest running `develop` battery, and **every `Release` run**; cancel the rest:

  ```bash
  # workflowName is NOT optional here — see the Release rule below.
  gh run list --limit 30 --json databaseId,headBranch,workflowName,status \
    --jq '.[]|select(.status=="queued" or .status=="in_progress" or .status=="pending")|"\(.databaseId) \(.status) \(.workflowName) \(.headBranch)"'
  gh pr list --state open --limit 50 --json headRefName --jq '[.[].headRefName]|join(" ")'
  gh run cancel <id>   # for each run whose branch is not an open PR's head
  ```

  Cancellation is asynchronous; re-list rather than cancelling twice. When in doubt about someone else's branch, leave it.
- **NEVER cancel a `Release` run, and check the workflow name before every cancel.** A release is dispatched with `workflow_dispatch --ref develop`, so its `headBranch` is `develop`: it is not an open PR's head, and it is not "the newest running `develop` battery" either. **The recipe above, read on `headBranch` alone, tells you to cancel it.** Measured 2026-09-19: run `35412206049` had its `release` job finish green — bumping `src/version.yo` to 0.2.37, pushing the bump commit, and creating the draft release — and was then cancelled ~30 minutes in, killing all six bundle jobs plus publish, seed-bundle, portable-C, site-deploy and the `SEED_VERSION` bump. It left the repository in a genuinely confusing half-released state: a `v0.2.37` draft with no tag, `src/version.yo` already saying 0.2.37, and `SEED_VERSION` still pinned to v0.2.36. Recovery is not a re-run — dispatch `bump=none`, which is the documented resume ("RESUMES an interrupted release at the version already in `src/version.yo`") and re-releases that version instead of skipping to 0.2.38.

  The `Cancel runs for closed PRs` workflow is NOT the hazard here: it guards long-lived branches by name and cancels only runs on the closed PR's own head ref, and its log for that window shows it cancelling exactly one unrelated run. The hazard is the manual sweep, which is why the listing above now prints `workflowName`.

  **A `bump=none` resume leaves the draft pointing at the WRONG commit — fix it before the publish job runs.** The draft was created by the dead run with `target_commitish` = that run's HEAD (the bump commit). The resume re-runs `Create GitHub Release` with `target_commitish: $(git rev-parse HEAD)`, which is now the *current* tip — but GitHub does not move `target_commitish` on a release that already exists, so the draft silently keeps the old value. Publishing then creates the tag on a commit the released binaries were NOT built from. Measured on v0.2.37: draft targeted `3869b9944` (the bump commit) while every bundle was built from `0c360b28e`, two commits later. A draft's target is still mutable because no tag exists yet, so correct it while the bundles build:

  ```bash
  gh api -X PATCH repos/:owner/:repo/releases/<draft-id> \
    -f tag_name=v<version> -f target_commitish=$(git rev-parse origin/develop) \
    --jq '{tag_name,target_commitish,draft}'
  ```

  Send `tag_name` on every draft PATCH — a body-only PATCH resets it to `untagged-…`. The publish job finds the draft by `tag_name == "v<version>" and .draft`, so keeping both fields intact is what keeps the handoff working. Re-read the draft afterwards and confirm `draft: true` before the publish job reaches it.

- **A push to `develop` always runs the full battery (28 jobs)**; `test.yml`'s docs-only fast path (`code=false`: 18 jobs with 15 skipped, reporting `success` having compiled nothing) is **PR-only**. A stacked PR (base not `develop`) runs a deliberately REDUCED battery (`full=false`). A skip count is not a diagnosis: read the `changes` job's log (`classification: code=…`, `battery: FULL|REDUCED`).
- **Never merge a docs-only PR to `develop` while a battery you are waiting on is in flight.** The push supersedes the pending run (one pending run per concurrency group), so the verdict you wanted never arrives. Back-to-back merges have the same effect: the gate becomes "whatever the LAST merge triggered". Park work under a freeze by pushing the branch without opening the PR (a bare branch push runs nothing; an open PR runs on every push, draft or not).
- **Before cutting a release, diff the code directories against the battery's head; do not reason from run ordering:**

  ```bash
  git diff --stat <battery-head-sha>..origin/develop -- src/ std/ tests/ .github/ scripts/ build.yo
  ```

  Empty ⇒ the battery gates the tip. Non-empty ⇒ wait for a battery on the new tip.
- A `cancelled` PR run with no newer run on that branch means the PR has no verdict: `gh run rerun <id>`. A PR with `mergeable=CONFLICTING` gets no runs at all: rebase and force-push. Branch protection's required-check list is manual: add every new CI job by hand.

---

## Common Pitfalls

- **`ExprInfo.value` of `.None`** means a runtime value; `EvalValue.UnknownVal` means the type is known but the value is not.
- **`assumed()` and `outside-subset` pass `yo verify`** by design (std dogfooding); a green `yo verify` is not "everything proved". Read the per-fn outcomes.
- **Two spellings of a module path coexist; never compare them with `==`.** Entry-module tokens carry the path as typed; demand-loaded ones carry the `file://<abs>` cache key. Canonicalize (`_canonical_module_path`) before comparing (`issues/fixed/static-library-exports-no-symbols.md`).
- **A `-O0` binary that SIGSEGVs (rc=139) on deep recursion is stack exhaustion, not heap corruption.** `main` runs on a worker thread with a 1 GiB stack (`YO_MAIN_STACK_MB` overrides); `-O0` frames of the big evaluator functions are multi-MB. Validate deep recursion with `--optimize 2`, or `YO_MAIN_STACK_MB=4096 <binary> check ./src`.
- **A "move" of a named local into a struct/enum field is NOT a consumption in the evaluator.** The move you see in the C is manufactured by the dup/drop pair optimizer (`_optimize_dup_drop_pairs`, `src/evaluator/exprs/begin.yo`), so a missing drop is an optimizer bug. Any tree walk in that family must follow `ExprInfo.macro_expansion` for macro calls (`issues/fixed/where-constraints-arraylist-96b-leak.md`).
- **Cancelling a dup/drop pair is only sound when the container outlives the local, and the optimizer does not check that.** Closure definitions with deferred dups are skipped for this reason (`issues/fixed/spawn-closure-captures-never-dropped-leak.md`); the inner-scope container case is documented in `issues/fixed/a-local-stored-in-a-struct-field-is-dangling-after-the-container-dies.md`. Any change here needs the dup/drop emit-diff gate plus an over-cancellation canary.
- **A single-expression begin block shares its AST node id with its tail expr**: the begin epilogue must concat, not replace, the tail's deferred lists; idempotence of drop emission comes from `FunctionGenerationContext.emitted_deferred_drop_ids`, never from list removal (`issues/fixed/ref-local-scope-drop-missing-after-value-call.md`).
- **A parameter is bound in three places** (`_build_def_time_body_env`, `_evaluate_funcval_runtime_call`, `check_if_function_parameter_matches_argument`); a function with `generic(...)` params defers its body to call time, so a new binding site must mirror the def-time binder's `own` flags (`issues/fixed/dyn-box-dispose-is-emitted-with-an-empty-body.md`). A leak that only reproduces through a generic callee is this before it is codegen.
- **A new build builtin in `std/build.yo`**: a module-level `::` VALUE binding breaks the whole module under the seed (E0401); a FUNCTION wrapper does not, and only a build file that CALLS it fails. The repository's own `build.yo` must not use a builtin until `SEED_VERSION` carries it. Pre-v0.2.31 seeds swallow build-file errors and print `No build steps defined.`.
- **`yo install` auto-prunes stale lock entries; the store is content-addressed** (`<cache>/store/sha256/<integrity>`), reclaimed only by `yo cache gc`. Every git child runs with `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=echo`.
- **The VS Code extension bundles a plain-JS LSP client** spawning `yo lsp` (`yo.binPath`); with `yo.lsp.enabled: false` it degrades to syntax highlighting.
- **Plans state their status up top.** `plans/archive/` docs are closed records with frozen numbers; `plans/reference/` docs are authoritative.

## Debugging codegen / C compilation issues

1. Document the issue in `issues/<name>.md`: the verbatim error, a minimal `.yo` reproducer (use `tmp/fixme.yo`), the root cause.
2. Fix the codegen in `src/codegen/`.
3. Verify: the repro compiles, the full project's error count decreases.
4. Move the doc to `issues/fixed/` and commit.

---

## Karpathy-Inspired Coding Guidelines

Behavioral guidelines to reduce common LLM coding mistakes (source: [andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)). They bias toward caution over speed; for trivial tasks, use judgment.

1. **Think before coding.** State assumptions; if several interpretations exist, present them instead of picking silently; if a simpler approach exists, say so; if something is unclear, stop and ask.
2. **Simplicity first.** Minimum code that solves the problem: no speculative features, no abstractions for single-use code, no unrequested configurability, no error handling for impossible cases. If 200 lines could be 50, rewrite.
3. **Surgical changes.** Touch only what you must; match existing style; do not "improve" adjacent code; mention unrelated dead code instead of deleting it. Remove imports/variables your change orphaned. Every changed line should trace to the request.
4. **Goal-driven execution.** Turn tasks into verifiable goals ("fix the bug" → "write a failing test, make it pass"; "refactor X" → "tests pass before and after"), state a short plan with a check per step, and loop until verified.
