---
mode: agent
---

You are a programming language and compiler expert.

Detailed instructions live in `.github/instructions/`. Read the relevant file before working in that area.

| Area                             | Instruction file                                     |
| -------------------------------- | ---------------------------------------------------- |
| C code generation                | `.github/instructions/c-codegen.instructions.md`     |
| Debugging evaluator / C output   | `.github/instructions/debugging.instructions.md`     |
| Running / writing tests, gates   | `.github/instructions/testing.instructions.md`       |
| Yo language design & std library | `.github/instructions/yo-design.instructions.md`     |
| Yo syntax rules                  | `.github/instructions/yo-syntax.instructions.md`     |
| Documentation                    | `.github/instructions/documentation.instructions.md` |

## Reading historical documents

`plans/`, `issues/` and `code-reviews/` are records and are not rewritten. Translate old names as you read:

| Old (in records)                                                                                         | Today                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/**.ts`, `bun`, `package.json`, `./yo-cli <args>`                                                    | the retired TypeScript compiler (git tag `src-attic-final`); `src/**.yo` is the compiler; `yo <args>`    |
| `yo-self/`, `yo-self/tests/`, `src/tests/fixme.yo`                                                       | `src/`, `tests/internal/`, `tmp/fixme.yo`                                                               |
| snake_case module files/dirs (`array_list`, `expr_info.yo`, `tests/foo_bar.test.yo`)                     | kebab-case (`array-list`, `expr-info.yo`, `tests/foo-bar.test.yo`); identifiers unchanged (`array_list :: import("std/collections/array-list")`). `exprs/_expr.yo` → `exprs/dispatch.yo`, `_fsm.yo` → `fsm.yo`; `std/fmt/to_string.yo` is still snake_case |
| `markdown_yo`, `raylib_yo`, `tetris_yo`, `markdown_it_yo`, `http_server_demo_yo`, `yo_http_benchmark`    | the kebab-case package/repo names (`markdown-yo`, …); the path `vendor/markdown_yo` (a retired submodule) keeps its spelling |
| `open(...)`                                                                                              | `{ ... } :: import("m")`, `{ a, b } :: SomeModule`, `{ x, y } := s` (`plans/reference/REMOVE_OPEN_BUILTIN.md`) |
| `imm(x) : T`, `mut(x) : T`, `inout(x) : T`, `imm(self)`, `-> imm(T)`, `for(xs, inout(x) => …)`           | `x : &T`, `x : &mut T`, `self : &Self`, `-> &T`, `for(&mut xs, x => …)` (decision 42; a mode word is now E0009) |
| a bare `{ a, b }` / `{ k : v }` VALUE; a value `{}`                                                      | the record `.{ a, b }` / `.{ k : v }`; `.{}` (`{}` is the unit block). Binders are unchanged (`plans/reference/BRACE_BLOCKS.md`) |
| `escape`                                                                                                 | `unwind`                                                                                                |
| the operator traits `Mod`, `Negate`, `BitLeftShift`, `BitRightShift` and their `Comptime*` twins           | `Rem`, `Neg`, `Shl`, `Shr` (`ComptimeRem`, …); members unchanged (`plans/backlog/STD_RUST_ALIGNMENT.md` §9) |
| `plans/backlog/NON_ESCAPABLE_TYPES.md`, `FUTURE_ORIGINS.md`                                              | `plans/backlog/REFERENCES_AND_ORIGINS.md` (decision 43; "non-escapable" is O10's `Escapable` bound)     |
| `BK_SUBTYPE_OF`, `src/evaluator/exprs/subtype-of.yo`, `evaluate_subtype_of`                               | `BK_IMPLEMENTS`, `src/evaluator/exprs/implements.yo`, `evaluate_implements` (`<:` is the bound operator, read *implements*; VERDICTS-85) |
| `phase6*` tests; `macro_expansion`, `macro_registry`, `macro_def_*`, `try_macro_assign` tests            | `quote-macro-eval`, `ast-reflection`, `macro-helpers`; the rest were deleted with the user-macro fixtures |

---

## Architecture

The compiler is **written in Yo**, lives in `src/`, and is self-hosting. It compiles Yo to C11 and hands the C to a system C compiler:

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

Building it needs an existing `yo`: a **seed release** (`SEED_VERSION` in `.github/workflows/test.yml`) or the published single-file `yo.c` (`scripts/make-portable-c.sh`). `build.yo` at the repo root builds the compiler (`yo build`). Record: `plans/archive/BOOTSTRAPPING.md`.

| Path                                                                                                                  | Role                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/`                                                                                                                | The compiler; `src/README.md` has the layout                                                                               |
| `src/main.yo`                                                                                                         | CLI entry point and subcommand dispatch                                                                                    |
| `src/lexer.yo`, `src/token.yo`, `src/parser.yo`, `src/expr.yo`                                                        | Tokens → AST; `expr.yo` holds the node types and builtin keyword constants                                                 |
| `src/expr-info.yo`                                                                                                    | `ExprInfo`: the per-expression side table the evaluator fills and codegen reads                                            |
| `src/evaluator/`                                                                                                      | Type checking, CTFE, trait resolution; `exprs/` per node, `calls/` specialization and dispatch, `effects/`, `builtins/`    |
| `src/verifier/`                                                                                                       | Formal verifier: `terms.yo` (VC IR), `vc.yo`, `encode.yo` (SMT-LIB 2), `z3.yo`, `driver.yo` (`plans/backlog/FORMAL_VERIFICATION.md`) |
| `src/codegen/`                                                                                                        | C11 emission; `exprs/`, `async/` (state machines, per-platform I/O runtimes), `functions/`, `parallelism/`, `c/allocator-fixed.yo` (TLSF) |
| `src/emitter.yo`                                                                                                      | The header / declaration / code buffers                                                                                    |
| `src/types/`                                                                                                          | Type values and compatibility helpers                                                                                      |
| `src/module-manager.yo`                                                                                               | Demand loader, cached prelude env, shared codegen `ExprInfoTable`, std-path resolution                                     |
| `src/manifest.yo`, `src/resolver.yo`, `src/fetch.yo`, `src/lock-file.yo`, `src/cache.yo`, `src/install-command.yo`, `src/toml-edit.yo` | `yo.toml`, `yo.lock` v2, the content-addressed store, `yo add\|remove\|install\|update`, `yo cache`             |
| `src/build-runner.yo`                                                                                                 | `yo build`: the build DAG and its scheduler                                                                                |
| `src/formatter.yo`, `src/lsp/`, `src/doc/`, `src/doc-command.yo`                                                      | `yo fmt`, `yo lsp`, `yo doc`                                                                                               |
| `src/init.yo`, `src/cli-lang.yo`, `src/version.yo`, `src/version-cache.yo`, `src/pkg-config.yo`, `src/target.yo`      | `yo init`, `--lang`/`YO_LANG` (en, zh-CN), `.yo-version`, release-bundle cache, pkg-config, target triples                 |
| `std/`                                                                                                                | Standard library; `std/build.yo` is the build API; `std/spec/` the verification vocabulary                                 |
| `tests/`                                                                                                              | Language tests (`*.test.yo`); `tests/spec/` the verifier's; `tests/internal/` the compiler's own (each file compiles the compiler); build-system and CLI subsystems are tested there |
| `tests/cli-cases/`, `scripts/cli-diff-test.sh`                                                                        | CLI goldens, each case sandboxed (own project dir and `HOME`), comparing rc + stdout + trees; `--record` writes goldens     |
| `scripts/bootstrap/`                                                                                                  | Gate batteries: `gates_fast.sh`, `fixpoint_only.sh`, `hollow_sweep69.sh`, `known-failing.tsv`                              |
| `plans/`                                                                                                              | Design docs: root = active, `reference/` = landed (authoritative), `backlog/` = not started, `archive/` = closed. `plans/README.md`, `plans/ROADMAP.md` |
| `issues/`                                                                                                             | Root = open bugs (each with `**Severity:**`); `questions/` = design decisions awaiting a verdict; `fixed/`, `retired/`, `repros/`, `patches/` (`issues/README.md`) |
| `docs/en-US/`, `docs/zh-CN/`                                                                                          | User docs, always both languages                                                                                           |
| `vscode-extension/`                                                                                                   | The only npm tree (`npm ci`, `npm run package`): a plain-JS LSP client spawning `yo lsp` (`yo.binPath`; `yo.lsp.enabled: false` = highlighting only) |

### Design decisions to know before writing Yo

The linked doc is authoritative.

- **Brace groups**: `.{ … }` builds a record, `{ names }` on a binding side picks fields, every other `{ … }` is a block (`{ e }` yields `e`, `{}` is unit) (`plans/reference/BRACE_BLOCKS.md`).
- **No function overloading** (`plans/reference/FUNCTION_OVERLOADING_POLICY.md`); the prelude's operator pairs are the only exported multi-candidate `Call` tuples.
- **No operator precedence**: parenthesize mixed adjacent operators (`a && b || c` is a parse error). A chain of ONE operator left-associates (`a - b - c` is `((a - b) - c)`) and `yo fmt` drops the redundant parens; parens on a RIGHT operand are kept (`plans/reference/OPERATOR_SET_AND_PRECEDENCE.md`).
- **Macros are gated**: definitions need `Pragma.AllowMacroDef`; `if(...)` desugars to `cond(...)` at parse time (`plans/reference/MACRO_POLICY.md`).
- **`::` definitions and `impl` registration are order-independent within a module** (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`).
- **`--target` is the canonical Rust triple**, no aliases (`plans/reference/TARGET_TRIPLES.md`).
- **`--allocator fixed`** is a TLSF allocator over one static region sized by `--heap-size` (`plans/reference/FIXED_REGION_ALLOCATOR.md`).
- **Dependencies live in `yo.toml`, not `build.yo`**; `import("dep")` resolves through the nearest manifest; only `yo build` fetches, so other commands need `yo install` first on a fresh clone (`plans/archive/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`).
- **No runtime dependent types**; runtime properties go through the verifier (`plans/reference/DEPENDENT_TYPES_POSITION.md`).
- **`match` is real pattern matching** (`plans/reference/MATCH_PATTERN_MATCHING.md`): exhaustiveness is usefulness (integer constants and ranges are intervals); an arm covered only collectively by earlier arms is a warning, single-arm subsumption an error; every infix pattern is parenthesized (`(p && (g))`, `(x := p)`); a bare identifier binds unless it names a literal/enum `::` constant.
- **No backward-compatibility scaffolding** (no external users): no deprecation windows, aliases or shims; the only gate is the seed (`plans/backlog/SEED_VERSION_AUTOMATION.md`).
- **Algebraic effects**: in a handler, `return(expr)` **resumes** the continuation; `unwind(expr)` **discards** it and exits the enclosing `fn` (an unwound async task enters `FutureState.Aborted`, state -2). C's `abort()` (process termination on panic) is unrelated.
- **Async is single-threaded per thread** (like JavaScript's event loop or tokio's `current_thread`, not C#): one event-loop thread owns all I/O submissions and completions, and a started task never migrates. No mutexes or atomics on async runtime variables. The parallelism runtime (`src/codegen/parallelism/`) is a separate, multi-threaded concern.

---

## Build & test

`yo` on `PATH` is the seed (`scripts/install.sh`, `--no-deps` on nix boxes; Windows: `scripts/install.ps1`, Git Bash needs `yo.cmd`). **Use the latest published release** (`yo --version`): the tree can need runtime symbols only the newest seed emits. Detail, timings and the incremental loop: `testing.instructions.md`.

```bash
yo check ./src --std-path ./std    # run FIRST; evaluator only. --std-path: without it the seed resolves its BUNDLED std
yo check ./std --std-path ./std
yo build --std-path ./std          # → yo-out/<target>/bin/yo; --std-path is load-bearing (CI builds stage 1 with the tree's std)
yo compile src/main.yo --skip-c-compiler   # catches what check cannot: a hollow `io.async` body (E0905) fires in codegen
nix develop . --command bash -c 'yo build --std-path ./std --cc clang'   # CI's C compiler; run the built binary inside the same wrapper

yo test ./tests/algebraic-effects.test.yo --bail -v --parallel 1 &> output.txt   # one file; save verbose output
yo test ./tests/algebraic-effects.test.yo --test-name-pattern "Test fn unwind" --parallel 1
yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail          # language suite (both excludes required)
yo test ./std --bail
yo test ./tests/internal/parser.test.yo --parallel 1   # internal tests: ONE file at a time, never the whole directory
yo verify ./std/collections --format json              # verifier; verify tests/spec per path, not as one directory

yo check ./tmp/fixme.yo                                # tmp/ is the gitignored scratch area
yo compile tmp/fixme.yo --emit-c --skip-c-compiler --optimize 2
yo compile tmp/fixme.yo --optimize 2 --sanitize address --allocator system -o test && ./test
```

- A missing Z3 is a skip-with-hint for `check` and a hard failure for `compile` (verify-mode binaries carry no runtime asserts). The FV CI job owns the proofs; `yo verify <file>` installs the pinned Z3.
- `yo compile` on a `*.test.yo` synthesizes no `main` (link fails). Extract the case into a standalone file with `main` and `export(main);`.
- Self-hosted gate batteries (`S1=<stage-1 binary> P=<prefix>`): `scripts/bootstrap/gates_fast.sh`, `fixpoint_only.sh`; `BIN=… OUT=… hollow_sweep69.sh` runs every language test through a built binary against `known-failing.tsv`.
- Project commands: `yo init`, `yo build [step] [--list-steps] [-Dname=value]`, `yo add|remove|install|update`, `yo cache path|clean|gc`, `yo version pin|install|list|clean`, `yo doc`, `yo explain E0xxx`, `yo fix <path>`, `yo context` (the language pack / API index). `yo <cmd> --help` for flags.

---

## Workflow rules

### Every change

- Run `yo check ./src` before any longer command, and `yo compile src/main.yo --skip-c-compiler` when async code changed.
- Make commands succeed yourself; do not ask the user to run them, and do not stop until they pass. If you have not modified code, do not re-run commands.
- No hardcoding, shortcuts or simplifications in the evaluator or codegen. A refactor covers everything: no placeholders, no TODOs.
- Do not create new `.yo` files unless told to.
- **Every bug you find gets filed**, never skipped: `issues/YYYY-MM-DD-<name>.md` (filing date) with a `**Severity:**` line (S1–S3, `issues/README.md`), a minimal reproducer (`tmp/fixme.yo`), the verbatim error and the root cause, plus a test in `tests/` that fails before the fix and passes after. When fixed, move the doc to `issues/fixed/`. An open design/API/policy decision is not a bug: `issues/questions/` with a `## Recommendation`. `scripts/check-issue-refs.sh` enforces both (CI `tree-hygiene`, which also rejects committed `<<<<<<<` markers).
- `issues/TRIAGE.md` is generated locally (`python scripts/gen-issue-triage.py`) and gitignored; never `git add` it.
- **`yo fmt` every `.yo` file you create or modify.** Verify with the tree-built binary (`yo-out/<target>/bin/yo fmt --check <files>`), not the seed: the formatter changes between releases and CI's fmt gate uses the tree binary. A `cancelled` battery means fmt is unverified, not green.
- **Every Yo code block is fenced ` ```yo `** in Markdown and doc comments, everywhere (`plans/` and `issues/` included); ` ```rust ` only for Rust. CI fmt-checks `docs/`, `plans/`, `.github/`, `README.md` and `issues/**.md`, so a block must parse; fence fragments and invalid examples ` ```yo ignore `.
- Docs under `docs/` are written in both `docs/en-US/` and `docs/zh-CN/`. Plans go in `plans/` (`plans/README.md`).
- Review `git diff` before calling work done: debug leftovers, unused imports, cross-file consistency.
- After a change, update what it made stale: `.github/instructions/`, `pack/context.md`, plans, docs. **A fact about Yo learned by trial and error goes immediately into the pack, the manual or `.github/instructions/`**, whichever is its home (`plans/backlog/AGENT_KNOWLEDGE_CONSOLIDATION.md` D2).
- **Keep `plans/ROADMAP.md` current**: a PR that lands, starts, slips, adds or drops a roadmap item (a release's scope, a plan adopted or finished) edits that item's one line in the same PR. Detail goes in the linked doc, never in the roadmap.
- **Heavy steps take a slot of the machine-wide FIFO lock**: `source scripts/heavy-lock.sh; heavy_take "<who>: <job>"` … `heavy_drop` (`testing.instructions.md`, "The heavy lock").
- **Sub-agents**: ping each idle sub-agent every 40 minutes (its prompt cache lives 1 h) for a one- or two-line reply with no tool calls. Never message an agent inside a Workflow run: that resumes a duplicate writing the same worktree.

### Git

- **The main checkout `$HOME/Workspace/Yo` is shared: never `checkout -b`, `pull`, `stash` or edit there.** Never `git stash` in a worktree either (the stash list is shared).
- **Worktrees live under `$HOME/Workspace/Yo-wt/<name>`, never `/tmp`** (cleared on reboot): `git worktree add -b <branch> $HOME/Workspace/Yo-wt/<name> origin/develop`, then `git -c protocol.file.allow=always submodule update --init`. Remove with `git worktree remove --force <path>`.
- **Commit and push before every heavy step** (`git push -u origin <branch>` after the first commit). Only a pushed commit is a backup.
- **PR bodies follow `.github/pull_request_template.md`** (Summary, Verification, LLM attribution, Deferred); `gh pr create --body` does not apply it.
- **Squash-merge and delete the branch**: `gh pr merge <n> --squash --delete-branch`. If that errors on a worktree, check `git ls-remote --heads origin <name>` and finish by hand (`git push origin --delete <name>`, `git worktree remove`, `git branch -D`). Set `GIT_TERMINAL_PROMPT=0` for `git ls-remote` against possibly missing repos.

### Gating: three tiers

A PR is admin-merged as soon as its Tier 1 passes; develop's battery is the full check and its failures are fixed forward. (One local box covers no Windows, arm64, TSan, wasm or seed-with-tree-std build; that cost is accepted.)

- **Tier 1, the merge gate** (~20–30 min, local, before opening the PR). Selection recipe: `testing.instructions.md`, "Choosing a Tier 1 gate".
  - `yo build --std-path ./std` when `src/` changed (otherwise reuse a develop-built binary); `check ./src` and `check ./std`.
  - The feature's own tests and tests naming a changed identifier, one file per `yo test` call, plus the `tests/internal` files that import a changed `src/` module or name a changed identifier, capped at ~8 (list the rest under Deferred).
  - `scripts/cli-diff-test.sh` when std, CLI output, diagnostics text or a `yo fix` migration changed; read each GOLDEN-DIFF before `--record`.
  - A change to what parses or type-checks outside `src/`/`std/` also needs: seed-run `yo test` steps in `.github/workflows/` run with the seed; `scripts/check-embedded-yo.sh`; and the tree binary first on `PATH` as `yo` for programs embedded in test string literals (`issues/fixed/2026-10-18-the-fv-job-runs-generation-a-test-files-with-the-seed.md`).
  - fmt and `scripts/check-issue-refs.sh`, on the final rebased head.
  - Not Tier 1: the full language suite, `yo test ./std`, the fixpoint. **Never run the whole `tests/internal` directory locally**, for any purpose.
- **Tier 2, the PR's battery**: not waited for; cancel it once the PR merges.
- **Tier 3, develop's battery**: two workflows on every develop push, together the full check: `test.yml` (the core battery, `merge-gate`) and `native.yml` (macOS, Windows and Linux arm64 legs, `native-gate`; PRs do not run it, `gh workflow run native.yml --ref <branch>` does). They cover every merge since their last run. Watch both by run ID; on red, find the causing PR and fix forward in a `fix(develop): …` PR (merged on its own Tier 1).
- **A flaky job gets one rerun** (`gh run rerun <run-id> --failed`). A second failure is real: investigate and file an `issues/` doc, even if the job looks unrelated.

### Stacking

- Stack only dependent pieces. Branch the next piece off the waiting one and open it as a **draft** (`gh pr create --draft --base <parent-branch>`): a stacked PR runs no CI. It merges into its parent once its own local gates pass. After the parent squash-merges:

  ```bash
  git fetch origin
  git rebase --onto origin/develop <old-parent-tip-sha> <branch>   # the parent's head BEFORE its squash-merge
  git push -f origin <branch>
  gh pr edit <n> --base develop && gh pr ready <n>                 # the retarget fires the full battery
  ```

- **One battery for a whole stack**: merge each piece into its parent on local gates, retarget only the top PR to `develop`.

### CI runs

The question is always: does the battery I am about to trust cover the code I am about to act on?

- **Triggers.** A push to `develop` runs the full battery; the docs-only fast path (`code=false`) is PR-only. PRs run only when their base is `develop`. A skip count is not a diagnosis: read the `changes` job's log (`classification: code=…`). A PR with `mergeable=CONFLICTING` gets no runs: rebase. A `cancelled` PR run with no newer run means no verdict: `gh run rerun <id>`.
- **The one required check is `merge-gate`** ("Merge gate (all checks)"): skipped dependencies satisfy it, failed or cancelled ones fail it. "Require branches up to date" is OFF: a PR green on its own head may merge behind develop. Add every new CI job to merge-gate's `needs:` in `test.yml` (a `native.yml` job to `native-gate`'s), not to the ruleset. Build jobs restore compiler binaries from a cache keyed on the compiler's inputs (`.github/actions/compiler-cache-key`); the repository variable `YO_CI_NO_BUILD_CACHE=1` turns it off.
- **Do not merge to `develop` while a battery you are waiting on is in flight**: the push supersedes the pending run. Park work by pushing the branch without opening a PR (an open PR runs on every push, draft or not).
- **Cancel runs a merge made pointless** (a squash-merged branch's runs gate nothing). Keep every open PR's runs, the newest running `develop` run of `test.yml` and of `native.yml`, **every `Release` run**, and every `ubsan.yml` and `fixpoint-arm64.yml` run (scheduled/dispatched on `develop`; 1–2 h to redo). Cancellation is asynchronous: re-list instead of cancelling twice. When in doubt about someone else's branch, leave it.

  ```bash
  # workflowName is NOT optional: a Release run's headBranch is `develop`.
  gh run list --limit 30 --json databaseId,headBranch,workflowName,status \
    --jq '.[]|select(.status=="queued" or .status=="in_progress" or .status=="pending")|"\(.databaseId) \(.status) \(.workflowName) \(.headBranch)"'
  gh pr list --state open --limit 50 --json headRefName --jq '[.[].headRefName]|join(" ")'
  gh run cancel <id>   # each run whose branch is not an open PR's head
  ```

- **"Yo-self" survives in two REQUIRED check names** ("Bootstrap fixpoint (yo-self self-compile)", "Self-hosted `test` subcommand (yo-self tier-1 gates)") and in artifact names like `/tmp/yo-self-bin`. Do not rename them.

### Releases

- **Cut only when develop's `test.yml` battery AND its `native.yml` run are green on the exact tip** (release.yml's gate checks both). Diff the code directories against each run's head; do not reason from run ordering. Empty ⇒ covered; otherwise wait for a battery on the new tip:

  ```bash
  git diff --stat <battery-head-sha>..origin/develop -- src/ std/ tests/ .github/ scripts/ build.yo
  ```

- **NEVER cancel a `Release` run; check the workflow name before every cancel.** A Release cancelled after its `release` job (version bump pushed, draft created) leaves a half-released repo: a draft with no tag, `src/version.yo` bumped, `SEED_VERSION` not.
  - **Resume** by dispatching Release with `bump=none` (re-releases the version already in `src/version.yo`), not by a re-run.
  - **Then fix the draft's target before the publish job runs**: GitHub keeps the dead run's `target_commitish` (the bump commit), so the tag would land on a commit the bundles were not built from. A draft's target is mutable until tagged:

    ```bash
    gh api -X PATCH repos/:owner/:repo/releases/<draft-id> \
      -f tag_name=v<version> -f target_commitish=$(git rev-parse origin/develop) \
      --jq '{tag_name,target_commitish,draft}'
    ```

    Send `tag_name` on every draft PATCH (a body-only PATCH resets it to `untagged-…`, and the publish job finds the draft by `tag_name == "v<version>" and .draft`). Re-read it and confirm `draft: true`.
- **Curate the release notes right after publishing.** The workflow writes line 1 (`Patch|Minor release vX.Y.Z`), a `## Changes` holding only the last squash commit's raw message, and the fixed `## Native bundles (bootstrap seed chain)` section. Rewrite only `## Changes` (model: `gh release view v0.2.38 --json body --jq .body`):

  ```bash
  gh release view vX.Y.Z --json body --jq .body > /tmp/old-body.md   # keep the original
  gh release edit vX.Y.Z --notes-file /tmp/new-body.md
  gh api repos/:owner/:repo/compare/vPREV...vX.Y.Z --jq '.commits[] | .sha[0:9] + " " + (.commit.message | split("\n")[0])'
  gh pr list --state merged --limit 60 --json number,title,body,mergedAt   # filter on the two tags' publish times
  ```

  - Line 1 and `## Native bundles` stay byte-for-byte.
  - `###` sections by audience, dropping empty ones: Type checking; Toolchain for agents (CLI, LSP, test runner, diagnostics); Compile and codegen; Async runtime; Build system and verification; Compiler performance and memory (always measured before → after); then `### Retracted claims` (an earlier published sentence, badge or number that was wrong: what it said, what is true, which PR fixed it) and `### Known open issues filed this cycle` (backticked `issues/<name>.md` paths open at the tag, no PR refs).
  - One bullet per user-visible change: what a user observes first, the mechanism after a dash, then `(#NNN)`. Omit plans-only and CI-only PRs; a research PR appears only through what it made observable.
  - No `*` commit bullets, no `Co-Authored-By` trailers, no AI attribution.

---

## Common pitfalls

- **`ExprInfo.value == .None`** is a runtime value; `EvalValue.UnknownVal` is a known type with an unknown value.
- **`assumed()` and `outside-subset` pass `yo verify`** by design; a green `yo verify` is not "everything proved". Read the per-fn outcomes.
- **Never compare module paths with `==`**: entry-module tokens carry the path as typed, demand-loaded ones the `file://<abs>` cache key. Canonicalize (`_canonical_module_path`) first.
- **A `-O0` binary that SIGSEGVs (rc=139) on deep recursion is stack exhaustion**, not heap corruption: `main` runs on a worker thread with a 1 GiB stack and `-O0` evaluator frames are multi-MB. Use `--optimize 2`, or `YO_MAIN_STACK_MB=4096 <binary> check ./src`.
- **gcc and clang disagree on emitted-C warnings**: CI builds with clang; `-Werror=return-type` stays load-bearing under gcc, so C clean under clang can fail a gcc build. `--cc` takes only `cc|gcc|clang|zig|emcc`.
- **A tree walk over evaluated code must follow `ExprInfo.macro_expansion` for macro calls**: an `if(...)` keeps its macro head in the AST; only the recorded `cond` expansion (the nodes codegen emits) shows the branches and carries their deferred dup and drop lists (`issues/fixed/where-constraints-arraylist-96b-leak.md`).
- **A single-expression begin block shares its AST node id with its tail expr**: the epilogue must concat, not replace, the tail's deferred lists; drop emission is idempotent through `FunctionGenerationContext.emitted_deferred_drop_ids`, never list removal.
- **A parameter is bound in three places** (`_build_def_time_body_env`, `_evaluate_funcval_runtime_call`, `check_if_function_parameter_matches_argument`). A `generic(...)` function defers its body to call time, so a new binding site must mirror the def-time binder's `own` flags; a leak reproducing only through a generic callee is this before it is codegen (`issues/fixed/dyn-box-dispose-is-emitted-with-an-empty-body.md`).
- **A new build builtin**: any use of it in `std/build.yo` (a `::` value or a wrapper body) fails the whole module under the seed (E0401, in `check ./std` and `yo build`). Land the builtin first (build files call `__yo_build_*` directly; a cli-case covers it), park the std wrapper in `plans/backlog/SEED_VERSION_AUTOMATION.md`, add it once `SEED_VERSION` carries the builtin. The repo's own `build.yo` waits for the seed too.
- **`yo install` auto-prunes stale lock entries**; the store is content-addressed (`<cache>/store/sha256/<integrity>`), reclaimed only by `yo cache gc`. Git children run with `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=echo`.
- **Plans state their status up top**; `plans/archive/` numbers are frozen, `plans/reference/` is authoritative.

---

## Karpathy-inspired coding guidelines

From [andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills); they bias toward caution over speed. For trivial tasks, use judgment.

1. **Think before coding.** State assumptions; if several interpretations exist, present them instead of picking silently; if a simpler approach exists, say so; if something is unclear, stop and ask.
2. **Simplicity first.** Minimum code that solves the problem: no speculative features, no abstractions for single-use code, no unrequested configurability, no error handling for impossible cases. If 200 lines could be 50, rewrite.
3. **Surgical changes.** Touch only what you must; match existing style; do not "improve" adjacent code; mention unrelated dead code instead of deleting it. Remove imports/variables your change orphaned. Every changed line should trace to the request.
4. **Goal-driven execution.** Turn tasks into verifiable goals ("fix the bug" → "write a failing test, make it pass"; "refactor X" → "tests pass before and after"), state a short plan with a check per step, and loop until verified.
