---
mode: agent
---

You are a programming language and compiler expert.

> **Translation note — `src/` means TWO different compilers depending on the era.
> Read this before trusting any path in `plans/` or `issues/`.**
>
> | you are reading | `src/` means | the Yo compiler is called |
> | --- | --- | --- |
> | live code, this file, `docs/`, `.github/` | **the Yo compiler** (current) | `src/` |
> | `plans/`, `issues/`, `code-reviews/`, `outdated/` | the **retired TypeScript** compiler | `yo-self/` |
>
> The TypeScript compiler that lived in `src/`, with the whole bun/node root toolchain
> (`package.json`, `bun.lock`, `tsconfig.json`, the `yo-cli` / `yo-cli.ps1` shims, …),
> was **retired and deleted in P2.5** (`plans/P2_RETIRE_SRC.md` item 2.5,
> `plans/P2_5_RETIRE_EXECUTION.md` — **LANDED**). It is frozen at the git tag
> **`src-attic-final`**; check that tag out to read the old reference implementation.
>
> The self-hosted compiler then **moved into the freed name**: `yo-self/` → `src/`
> (P2.5 Group F, 2026-08-20). So a historical document saying "`src/evaluator/eval.ts`"
> means the DELETED compiler, while "`yo-self/evaluator/eval.yo`" means what is now
> `src/evaluator/eval.yo`. Those documents are **historical records and are not
> rewritten** — translate as you read, using the table above.
>
> **The file extension disambiguates, always.** The deleted compiler was TypeScript
> and the current one is Yo, so `src/**.ts` is ALWAYS the retired implementation
> (~276 live docs still cite it — cleaning those is P2.5 step 30, the docs sweep)
> and `src/**.yo` is ALWAYS the current one. When a path's era is unclear, look at
> the extension before anything else.
>
> **"yo-self" survives as a NAME, not a path.** It still names the self-hosted compiler
> in prose, in two REQUIRED CI check names ("Bootstrap fixpoint (yo-self self-compile)",
> "Self-hosted `test` subcommand (yo-self tier-1 gates)") and in artifact names like
> `/tmp/yo-self-bin`. Renaming those check names would remove two required status
> checks and block every PR in the repository, so they are deliberately left alone.

Detailed instructions for specific areas are in `.github/instructions/`. Always read and follow the relevant file before working in that area.

| Area                             | Instruction file                                     |
| -------------------------------- | ---------------------------------------------------- |
| C code generation                | `.github/instructions/c-codegen.instructions.md`     |
| Debugging evaluator / C output   | `.github/instructions/debugging.instructions.md`     |
| Running / writing tests          | `.github/instructions/testing.instructions.md`       |
| Yo language design & std library | `.github/instructions/yo-design.instructions.md`     |
| Yo syntax rules                  | `.github/instructions/yo-syntax.instructions.md`     |
| Documentation                    | `.github/instructions/documentation.instructions.md` |

---

## Architecture

The Yo compiler is **written in Yo**, lives in `src/`, and is self-hosting — the `yo` binary that compiles this tree was itself compiled from this tree. It compiles Yo source code to C11 via several pipeline stages, then hands the C to a system C compiler:

```
Yo source → Lexer → Parser → AST (expr.yo)
                                  ↓
                             Evaluator   ← compile-time evaluation, type checking, CTFE
                                  ↓
                             Codegen     ← emits C11 code
                                  ↓
                          C compiler (clang/gcc/zig)
```

Because it is self-hosting, building it needs an existing `yo`. That comes from a **seed
release** — the published bundle of a previous version compiles the current tree — or, with
no binary at all, from the published single-file `yo.c` (`scripts/make-portable-c.sh`,
`plans/PORTABLE_C_DISTRIBUTION.md`). `plans/BOOTSTRAPPING.md` is the campaign record;
`scripts/install.sh` installs a bundle; `build.yo` at the repo root is how the compiler
builds itself (`yo build`).

### Key directories

| Path                                         | Role                                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`                                   | **The Yo compiler**, written in Yo — the only compiler in this repo (bootstrap COMPLETE: full suite green, stage-2/stage-3 FIXPOINT HOLDS, CI-gated — record: `plans/BOOTSTRAPPING.md`)                       |
| `src/README.md`                          | Bootstrap status, layout, and test instructions                                                                                                                                                               |
| `src/main.yo`                            | CLI entry point — the `yo` binary's argument parsing and subcommand dispatch                                                                                                                                  |
| `src/lexer.yo`, `src/token.yo`       | Tokenizes Yo source into tokens                                                                                                                                                                               |
| `src/parser.yo`                          | Parses tokens → AST                                                                                                                                                                                           |
| `src/expr.yo`                            | Core AST node types (`Expr`, `ControlFlowKind`, `BuiltinKeywords`, …)                                                                                                                                         |
| `src/expr_info.yo`                       | `ExprInfo` — the per-expression annotation side table the evaluator fills in and codegen reads                                                                                                                |
| `src/evaluator/`                         | Compile-time evaluator — type checking, CTFE, trait resolution                                                                                                                                                |
| `src/evaluator/exprs/`                   | Per-node evaluation logic (`begin.yo`, `cond.yo`, `unwind.yo`, …)                                                                                                                                             |
| `src/evaluator/calls/`                   | Function call specialization and dispatch                                                                                                                                                                     |
| `src/evaluator/effects/`                 | Algebraic effects analysis                                                                                                                                                                                    |
| `src/codegen/`                           | C11 code generation                                                                                                                                                                                           |
| `src/codegen/exprs/`                     | Per-node C emitter (`generation.yo`, `return.yo`, `async.yo`, …)                                                                                                                                              |
| `src/codegen/async/`                     | Async/effect state-machine C emitter + the per-platform async I/O runtimes                                                                                                                                    |
| `src/codegen/functions/`                 | Function-level C emitters                                                                                                                                                                                     |
| `src/codegen/parallelism/`               | Parallelism runtime emitter                                                                                                                                                                                   |
| `src/emitter.yo`                         | Core C emitter — the headers / declarations / code buffers everything writes into                                                                                                                             |
| `src/types/`                             | Type value definitions and compatibility helpers                                                                                                                                                              |
| `src/module_manager.yo`                  | "Evaluate a `.yo` file and read its exports" service — used by build/fetch/install/doc/test-runner/codegen; the demand module loader, cached prelude env, shared codegen `ExprInfoTable`, std-path resolution |
| `src/formatter.yo`                       | `yo fmt` — the source formatter and its directory walker                                                                                                                                                      |
| `src/build_runner.yo`                    | `yo build` — build execution engine, including the build DAG and its level-based scheduler, plus artifact compilation                                                                                         |
| `src/install_command.yo`                 | `yo install` — add git/path dependencies                                                                                                                                                                      |
| `src/fetch.yo`                           | Git dependency fetching, lock file pruning                                                                                                                                                                    |
| `src/fetch_command.yo`                   | `yo fetch` CLI driver                                                                                                                                                                                         |
| `src/lock_file.yo`                       | `yo.lock` parse/write                                                                                                                                                                                         |
| `src/cache.yo`                           | Global dependency cache (`~/.cache/yo/deps/`) + version cache helpers                                                                                                                                         |
| `src/init.yo`                            | `yo init` — project scaffolding                                                                                                                                                                               |
| `src/version.yo`                         | `.yo-version` discovery, parsing, validation                                                                                                                                                                  |
| `src/version_cache.yo`                   | Release-bundle download from GitHub Releases, cache management, runtime detection                                                                                                                             |
| `src/doc_command.yo`                     | `yo doc` CLI — documentation generation                                                                                                                                                                       |
| `src/doc/`                               | Doc pipeline: extractor, builder, model, renderers                                                                                                                                                            |
| `src/pkg_config.yo`                      | pkg-config integration for system libraries                                                                                                                                                                   |
| `std/`                                       | Yo standard library (`.yo` source)                                                                                                                                                                            |
| `std/build.yo`                               | Build system API (Project, Step, Executable, etc.)                                                                                                                                                            |
| `build.yo`                                   | Repo-root build file — `yo build` compiles the compiler with itself into `yo-out/<target>/bin/yo`                                                                                                             |
| `tests/`                                     | Integration test files (`*.test.yo`)                                                                                                                                                                          |
| `tests/internal/`                            | Tests for the compiler itself (60 files; **was `yo-self/tests/` until 2026-08-05** — translate that path in older docs; see `src/README.md` for tiers & heavy files)                                      |
| `scripts/cli-diff-test.sh`                   | Harness for CLI SUBCOMMANDS — runs a case in an isolated sandbox (own project dir, own `HOME`), comparing rc + stdout + both trees. With the TypeScript tree gone it scores against recorded goldens (`--record`)          |
| `tests/cli-cases/`                           | The CLI corpus consumed by `scripts/cli-diff-test.sh`. Every case under it is live — there is no `pending/` holding area                                                                                              |
| `plans/BUILD_SYSTEM.md`                      | Build system design document                                                                                                                                                                                  |
| `plans/DEPENDENCY_MANAGEMENT.md`             | Dependency management design                                                                                                                                                                                  |
| `plans/VERSION_MANAGEMENT.md`                | `.yo-version` pinning and version cache design                                                                                                                                                                |
| `plans/HIGHER_KINDED_TYPES.md`               | HKT design & implementation (TypeApplication, partial application)                                                                                                                                            |
| `plans/FUNCTOR_APPLICATIVE_MONAD.md`         | Option/Result functional combinators plan                                                                                                                                                                     |
| `plans/BOOTSTRAPPING.md`                     | Bootstrap campaign record (GOAL ACHIEVED — fixpoint holds, suite green); umbrella over the CLOSED per-slice docs                                                                                              |
| `plans/SELF_HOSTING_COMPLETION.md`           | The self-hosting roadmap: P1 CLI parity (**COMPLETE**), P2 retire `src/`+bun (**COMPLETE**), P3 release bundles + install scripts (Koka model), P4 LSP + VS Code (**FEATURE-COMPLETE 2026-08-22**)                                              |
| `plans/P1_CLI_PARITY.md`                     | P1 record — full subcommand parity in `yo-self` (COMPLETE 2026-08-10); the method notes are still the reference for CLI-parity work                                                                           |
| `plans/P2_RETIRE_SRC.md`                     | P2 record — seed release, repo-root `build.yo`, CI migration, TS-only tests re-expressed in Yo, and the `src/` retirement itself (**LANDED**)                                                                 |
| `plans/P2_5_RETIRE_EXECUTION.md`             | The measured execution plan for the deletion — the audit, the nine prerequisites, and the step-by-step record (**LANDED**)                                                                                    |
| `plans/P3_DISTRIBUTION.md`                   | Release bundles, install scripts, `yo version` against GitHub Releases                                                                                                                                        |
| `plans/P4_LSP.md`                            | The LSP + VS Code phase — **FEATURE-COMPLETE 2026-08-22**: `yo lsp` serves stdio LSP with diagnostics at exact ranges, hover, definition, symbols, references, folding, rename, formatting, signature help and completion (`src/lsp/`, one module per feature); the extension carries a plain-JS client (`yo.binPath`). Remaining quality items (typed diagnostics channel, doc-comment plumbing) are listed in the plan header |
| `plans/MACRO_POLICY.md`                      | Macro keep-vs-delete audit + decision (LANDED 2026-08-21): keep macros, gate definitions behind `Pragma.AllowMacroDef`, remove std `try`, desugar `if`→`cond` at parse time (prelude `if` kept as seed fallback) |
| `plans/OPERATOR_SET_AND_PRECEDENCE.md`      | Closed operator token set (fixes `**i32` maximal-munch ambiguity) + reserved-operator list; no-precedence stance AFFIRMED 2026-08-21, consensus-core alternative documented as deferred                        |
| `plans/archive/FMT_PAREN_CANONICALIZATION.md` | REJECTED fmt paren removal (2026-08-21): fmt stays paren-preserving like gofmt; "don't write unnecessary parens" is authoring guidance in yo-syntax.instructions.md instead                                |
| `plans/archive/YO_SELF_EXPRINFO_PRUNE.md`    | REJECTED `yo-self` memory lever: pruning the process-lifetime `ExprInfoTable` (built, measured, refuted)                                                                                                      |
| `plans/backlog/YO_SELF_ENV_SHARING.md`       | The real `yo-self` memory root cause: def-time body envs COPY what TS SHARES (7.4 M live `Variable`s), plus the remaining ranked levers                                                                       |
| `plans/backlog/RC_POLICY_MECHANISM_SPLIT.md` | RC dup/drop architecture: policy (evaluator) vs mechanism (codegen), the codegen-side policy-patch inventory, and why full evaluator-only generation is impossible                                            |
| `plans/backlog/SEED_VERSION_AUTOMATION.md`  | BACKLOG (2026-08-21): SEED_VERSION consistency guard across the 3 workflows + release-time direct bump push via RELEASE_PAT (no [skip ci], so the new seed is exercised immediately); scheduling point for seed-gated follow-ups |
| `plans/FUNCTION_OVERLOADING_POLICY.md`      | No function overloading (Rust stance, 2026-08-21): exported `Call` tuples of ≥2 candidates are prelude-only (the runtime/comptime operator pairs); single-function `Call` (callable module) stays; audit of every overloading channel |
| `plans/backlog/DUPLICATE_INHERENT_METHOD_REJECTION.md` | BACKLOG (2026-08-21): reject duplicate inherent method impls (today silently accepted, first-wins/arity-dispatch — issues/fixed/duplicate-inherent-method-impls-not-rejected.md); keyed on defining-expr identity so loader re-registration stays legal |

**Renamed 2026-08-06 — translate these in older docs.** The `phase6*` prefix named an
internal porting-plan phase and meant nothing to a reader, so the four macro/reflection
test files (and the test names inside them) were renamed to say what they cover:

| old                             | new                        |
| ------------------------------- | -------------------------- |
| `phase6_verify.test.yo`         | `quote_macro_eval.test.yo` |
| `phase6c_macro.test.yo`         | `macro_expansion.test.yo`  |
| `phase6d_reflection.test.yo`    | `ast_reflection.test.yo`   |
| `phase6f_macro_helpers.test.yo` | `macro_helpers.test.yo`    |

### Algebraic effects model

- `return(expr)` inside an effect handler **resumes** the continuation.
- `unwind(expr)` inside an effect handler **discards** the continuation and exits the enclosing `fn`. (Was previously named `escape` — renamed in commit `a3510d20`.)
- When an async task is unwound, the Future enters `FutureState.Aborted` (state = -2).
- C's `abort()` (process termination on panic) is a **different thing** — never confuse the two.

### Async/await threading model

Yo's async/await is **single-threaded** (like C#). All I/O submissions and completions run on one event loop thread. Do not add mutexes or atomics to async runtime variables. The parallelism runtime (`src/codegen/parallelism/`) is a separate multi-threaded concern.

---

## Build & Test Commands

The compiler is the `yo` binary on your PATH (install it with `scripts/install.sh`, or
build one from this tree with `yo build` — see below). There is no `./yo-cli` shim and no
`bun run build` step any more: **every `./yo-cli <args>` in older docs is `yo <args>`.**

```bash
# Build the compiler with itself (repo-root build.yo) → yo-out/<target>/bin/yo
yo build

# Type-check the whole compiler tree — this is the error check you run before
# anything else (evaluator-only, no codegen)
yo check ./src

# Build-system tests. The old `bun test src/tests/build-system.test.ts` was
# re-expressed in Yo under tests/internal/ (P2 item 2.4); its siblings there
# cover the rest of the CLI subsystems — fetch, lock_file, install_command,
# cache, init, version, pkg_config.
yo test ./tests/internal/build_runner.test.yo --parallel 1

# C codegen tests — specific file (always use --parallel 1 for single files)
yo test ./tests/algebraic_effects.test.yo --bail -v --parallel 1

# C codegen tests — specific test by name
yo test ./tests/algebraic_effects.test.yo --test-name-pattern "Test fn unwind" --parallel 1

# Compiler internal tests (tests/internal — was yo-self/tests until 2026-08-05).
# Run the file(s) covering what you changed.
# Files importing evaluator internals take 1–10 min each (big Yo-compile).
# MEASURED 2026-08-05 (58 files, --parallel 1): 22.2 min for the whole directory.
# The old "~90 min" figure was pessimistic — it dated from the retired TS
# compiler, which took 40.5 min for the same set.
# Run ONE FILE AT A TIME: macro_expansion alone needs 6.52 GB, so two concurrent
# children on a 16 GB machine swap, and the swapping trips the runner's own
# 600 s evaluator deadline — MANUFACTURING failures that do not reproduce in
# isolation. Note the runner ignores --parallel anyway
# (src/main.yo: "Accepted for CLI compatibility; v1 runs sequentially").
yo test ./tests/internal/lexer.test.yo --parallel 1
yo test ./tests/internal/parser.test.yo --parallel 1
yo test ./tests/internal --parallel 1

# Fast language suite (~30 min on Mac Mini M4, safe to run locally). The
# tests/internal exclude is what keeps it fast — it compiles the compiler 58
# times. The tests/cli-cases exclude is CORRECTNESS, not speed: cli-case
# fixture trees contain .test.yo files that are harness inputs, including one
# that MUST fail (build-test-exclude's "must never run"), so without it the
# suite reports ~4 false failures. This mirrors CI (test.yml).
yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail

# Self-hosted gate battery (needs a built yo-self binary in $S1). GATE 4 is
# `check ./src`, which type-checks the whole tree rather than one import
# closure. (It USED to be the only thing covering build_runner.yo and
# version_cache.yo — no longer true as of 2026-08-16: main.yo imports both.)
# NOTE `check` is evaluator-only. The async state-machine restrictions — e.g.
# "`io.await` in a cond condition must BE the first condition" — are enforced in
# CODEGEN, so `check` passes over them. Use `compile src/main.yo
# --skip-c-compiler` (~3 min) to catch that class before pushing.
S1=/tmp/yo-s1 P=local bash scripts/bootstrap/gates_fast.sh
S1=/tmp/yo-s1 P=local bash scripts/bootstrap/fixpoint_only.sh

# Full-corpus hollow sweep: every language test file through the SELF-HOSTED
# binary, scored honestly (a batch `__yo_user_main` that is a "Failed to
# transpile" comment reports "N passed" while running nothing). Resumable via
# $OUT/results.txt. Gated as a ratchet against scripts/bootstrap/known-failing.tsv
# (<path> <verdict> pairs, HOLLOW and RED), so it fails on any NEW regression, on a
# stale allowlist entry, and on a file that merely CHANGES verdict.
BIN=/tmp/yo-s1 OUT=/tmp/hsweep bash scripts/bootstrap/hollow_sweep69.sh

# Evaluator-only check (fast, no codegen — useful for type-check iteration during refactors)
yo check ./std
yo check ./tmp/fixme.yo

# Emit C only (inspect generated code)
yo compile tmp/fixme.yo --emit-c --skip-c-compiler --release

# Full compile + run
yo compile tmp/fixme.yo --release -o a.out && ./a.out

# Compile with AddressSanitizer
yo compile tmp/fixme.yo --release --sanitize address --allocator system -o test && ./test
```

Always save verbose output to a file to avoid terminal truncation:

```bash
yo test file.yo --bail -v &> output.txt
yo compile tmp/fixme.yo --release &> compile_output.txt
```

### Build system commands

```bash
# Initialize a new project
yo init [dir] --name my-project

# Build project (default: install step)
yo build
yo build run          # Build and run
yo build test         # Run tests
yo build --list-steps # List available steps
yo build -Dname=value # Pass build options

# Generate documentation
yo doc ./std           # Generate docs for directory
yo doc -o ./yo-out/doc # Custom output directory
yo doc --format json   # Output as JSON (default: html)

# Dependency management
yo fetch              # Fetch all git dependencies
yo fetch --update     # Re-resolve refs to latest commits
yo install user/repo  # Install from GitHub (latest semver tag)
yo install user/repo@v1.0.0  # Install pinned version
yo install ./path     # Install local path dependency
yo cache path         # Print global cache directory
yo cache clean        # Remove all cached dependencies

# Version management
yo version            # Show current + pinned version
yo version pin        # Pin project to current Yo version
yo version pin 0.2.4 # Pin to specific version
yo version install 0.2.9  # Pre-download a version
yo version list       # List cached versions
yo version list --remote   # List published releases (GitHub Releases; npm publishing stopped at v0.2.0)
yo version clean      # Remove all cached versions
```

---

## Universal Workflow Rules

- Always run `yo check ./src` to ensure the compiler tree still type-checks before running longer `yo` commands. (This replaced `bun run build` when the TypeScript `src/` retired — there is nothing to transpile any more.)
- **There is no JavaScript runtime at the repo root** — no bun, no npm, no node, no `package.json`. Do not add one, and do not reach for `npm install` to "fix" something here. **The one exception is `vscode-extension/`, which is a deliberate npm-only island** (`npm ci`, `npm run package`), with `package-lock.json` committed and no `bun.lock`. It is a VS Code client and `vsce` is npm-native; `npm version` is what bumps its version at release time. Since 2026-08-22 it carries a plain-JS LSP client (no build step) spawning `yo lsp`; before that it was syntax-only (P2.5 B2 interim). The wasm CI legs also install node, because `emcc` is itself a node program; that is not a repo-root toolchain.
- Make sure commands run successfully. Don't ask the user to run — run them yourself. Don't end the conversation until the command succeeds.
- Never hardcode any Yo when solving a problem. Always go with a proper implementation. No shortcuts. Don't simplify the problem.
- While implementing the evaluator or codegen, no shortcuts or simplifications!
- Do not create new `.yo` files unless told to do so.
- When asked to refactor, refactor everything. Don't miss any lines. Don't put placeholders or TODOs.
- Never skip bugs discovered during implementation.
- After fixing a bug, verify uncommitted changes for leftover or unused code.
- Always review all uncommitted changes (`git diff`) before considering work done. Check for leftover debug code, unused imports, and consistency across all modified files.
- **Always run `yo fmt <file.yo>` on every `.yo` file you create or modify, before committing.** Use `yo fmt --check` to verify. Do not commit unformatted `.yo` files. (There is no pre-commit hook any more — `.husky/` went with the node toolchain, so this is on you.)
- Always check if there is need to create/update existing instructions & rules & skill files, design/plan docs after implementing a change.
- **Whenever you learn something new about Yo syntax, semantics, or common pitfalls — especially from trial and error — immediately update the relevant skill files** (`.github/skills/yo-syntax/syntax-cheatsheet.md`, `.github/skills/yo-core-patterns/core-patterns-cheatsheet.md`, etc.) **and instruction files** (`.github/instructions/yo-syntax.instructions.md`, `.github/instructions/yo-design.instructions.md`). This keeps the institutional knowledge accurate for future sessions.
- Always put design/plan documents in `plans/` directory (e.g., `plans/FEATURE_NAME.md`). Completed/superseded plans get a closing banner and move to `plans/archive/` (see `plans/README.md`).
- Always put the issues or bugs you found in `issues/` directory (root = open). Verified fixes move to `issues/fixed/`; snapshots made moot by later events move to `issues/retired/`; reproducers and patches go in `issues/repros/` and `issues/patches/` (see `issues/README.md`). Update references when moving (`grep -rn "issues/<name>.md"`).
- Always add test cases for any bug you found, and verify they fail before fixing the bug. After fixing, verify the new test cases pass and add them to `tests/` test set.
- The full test suite (`yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail`) takes ~30 minutes on a Mac Mini M4 and is safe to run locally. For faster iteration, run targeted test files instead.
- If you haven't modified the code, don't ask to run commands repeatedly.
- Ignore `DESIGN.md` and other markdown files in `outdated/` — they are out of date.
- `tmp/fixme.yo` is the scratch file for experimentation (`.gitignore` covers `tmp*`, so it is never committed). There is no need to restore its contents after modifying it. It replaced `src/tests/fixme.yo`, which older docs still name.
- When creating or updating docs in `docs/`, always write both English (`docs/en-US/`) and Chinese (`docs/zh-CN/`) versions.
- Use ` ```rust ` (not ` ```yo `) for Yo language code blocks in Markdown files — Rust highlighting renders better on GitHub.

---

## Common Pitfalls

- **An `ExprInfo.value` of `.None`** means the value is a runtime value (not `UnknownVal`). `EvalValue.UnknownVal` means the type is known but the value itself is not. (TS-era docs write this as `expr.$.value == undefined` / `UnknownValue`.)
- **`yo compile` cannot be used on `*.test.yo` files.** Extract the failing test case into a standalone `.yo` file with a `main` function and `export(main);` (the bare `export main;` form older docs show does not parse).
- **Algebraic effect `unwind` vs C `abort()`**: They are completely different. The Yo keyword `unwind` discards a continuation; C's `abort()` terminates the process. (`unwind` was previously named `escape`, renamed in commit `a3510d20`.)
- **The VS Code extension bundles an LSP client since 2026-08-22** (plain JS, no build step): it spawns `yo lsp` (configurable via `yo.binPath`), which serves the FULL feature set — diagnostics, hover, definition, symbols, references, folding, rename, formatting, signature help, completion (P4 feature-complete 2026-08-22, `plans/P4_LSP.md`). With `yo.lsp.enabled: false` (or no yo binary) it degrades to syntax highlighting.
- **`outdated/` markdown files are stale.** Do not use them for design decisions.
- **`yo fetch` auto-prunes stale lock entries.** When a dep is removed from `build.yo`, running `yo fetch` removes it from `yo.lock`. Global cache is not auto-cleaned.
- **`GIT_TERMINAL_PROMPT=0`** must be set when running `git ls-remote` on potentially non-existent repos to prevent interactive credential prompts.
- **A "move" of a named local into a struct/enum field is NOT a consumption in the evaluator.** `set_expr_as_consumed` (`src/evaluator/utils.yo`) only fires for owning temps and `own` parameters; a named local passed to a struct literal gets a deferred `___dup` (copy semantics), and the move you see in the emitted C is manufactured by the **dup/drop pair optimizer** (`_optimize_dup_drop_pairs` in `src/evaluator/exprs/begin.yo`) cancelling that dup against the scope-end drop. So a missing drop in the C is an optimizer bug, not a consumption-marking bug — and any tree walk in that optimizer family must follow `ExprInfo.macro_expansion` for macro calls (`for`, collection literals, user macros — their calls keep the macro head in the AST; the expansion is where branch structure is visible). `if(...)` no longer needs this: since 2026-08-21 it is desugared to `cond(...)` at parse time (`desugar_if_calls`, plans/MACRO_POLICY.md), so passes see the real `cond` node. See `issues/fixed/where-constraints-arraylist-96b-leak.md`.
- **A `-O0` binary that SIGSEGVs (rc=139) on deep recursion is stack exhaustion, NOT heap corruption — don't chase ASan/malloc.** Compiled Yo programs run `main` on a worker thread whose stack defaults to 1 GiB (`__yo_main_stack` in `src/codegen/functions/generation.yo`) and is overridable at runtime via the `YO_MAIN_STACK_MB` env var. At `-O0` (the default, non-`--release` build) clang gives every temporary its own stack slot, so the big evaluator functions (`evaluate_match` ~9 MB, `evaluate_function_call` ~8 MB) have multi-MB frames; deep compile-time recursion — e.g. `derive(Eq)` over a ~46-variant enum unrolling `__yo_comptime_fold_range` once per variant — then exhausts a 1 GiB stack at ~45 levels (≈22 MB/level). This is why `check ./src` crashed under `is_executing`. **`--release` (-O2, `src/main.yo`) shrinks frames ~100× via LLVM stack coloring (only runs at `-O1`+), needing <1 MB/level — it handles 1000+ levels on 1 GiB and never hits this.** So: validate the self-hosted compiler under deep recursion either with `--release`, or keep the fast `-O0` loop and bump the stack: `YO_MAIN_STACK_MB=4096 <binary> check ./src`. Diagnose this class of crash by rc=139 with no ASan output + a sharp deterministic depth threshold (it scales linearly with the stack size). The default is kept at 1 GiB (reserved lazily) so CI runners are not asked to reserve gigabytes.

## Debugging codegen / C compilation issues

When you encounter a C compilation error from `yo compile`, follow this
workflow:

1. **Document the issue** in `issues/<name>.md` with:
   - The error message (verbatim)
   - A **minimal `.yo` reproducer** (use `tmp/fixme.yo`)
   - The root cause analysis
2. **Create the minimal repro** — a tiny `.yo` file that triggers the same
   error. This isolates the bug from the noise of a full build.
3. **Fix the codegen** in `src/codegen/`.
4. **Verify** by compiling the repro (should succeed) and the full project
   (error count should decrease).
5. **Move the doc** to `issues/fixed/` and commit.

---

## Karpathy‑Inspired Coding Guidelines

Behavioral guidelines to reduce common LLM coding mistakes. (Source: [andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills))

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
