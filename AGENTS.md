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

---

## Architecture

The Yo compiler is a TypeScript program that compiles Yo source code to C11 via several pipeline stages:

```
Yo source → Lexer → Parser → AST (expr.ts)
                                  ↓
                             Evaluator   ← compile-time evaluation, type checking, CTFE
                                  ↓
                             Codegen     ← emits C11 code
                                  ↓
                          C compiler (clang/gcc/zig)
```

### Key directories

| Path                                 | Role                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lexer.ts`                       | Tokenizes Yo source into tokens                                                                                                                                                |
| `src/parser.ts`                      | Parses tokens → AST                                                                                                                                                            |
| `src/expr.ts`                        | Core AST node types (`Expr`, `ControlFlowKind`, `BuiltinKeywords`, …)                                                                                                          |
| `src/evaluator/`                     | Compile-time evaluator — type checking, CTFE, trait resolution                                                                                                                 |
| `src/evaluator/exprs/`               | Per-node evaluation logic (`begin.ts`, `cond.ts`, `unwind.ts`, …)                                                                                                              |
| `src/evaluator/calls/`               | Function call specialization and dispatch                                                                                                                                      |
| `src/evaluator/effects/`             | Algebraic effects analysis                                                                                                                                                     |
| `src/codegen/`                       | C11 code generation                                                                                                                                                            |
| `src/codegen/exprs/`                 | Per-node C emitter (`generation.ts`, `return.ts`, `async.ts`, …)                                                                                                               |
| `src/codegen/effects/`               | Effect state machine C emitter                                                                                                                                                 |
| `src/codegen/functions/`             | Function-level C emitters                                                                                                                                                      |
| `src/types/`                         | Type value definitions and compatibility helpers                                                                                                                               |
| `src/yo-cli.ts`                      | CLI entry point for `yo` / `yo-cli`                                                                                                                                            |
| `std/`                               | Yo standard library (`.yo` source)                                                                                                                                             |
| `tests/`                             | Integration test files (`*.test.yo`)                                                                                                                                           |
| `yo-self/`                           | Bootstrap: self-hosted Yo compiler written in Yo (evaluator + codegen ports DONE; tests 186/186 green, stage-2/stage-3 FIXPOINT HOLDS — see `plans/YO_SELF_STAGE2_HANDOFF.md`) |
| `yo-self/README.md`                  | Bootstrap status, layout, and test instructions                                                                                                                                |
| `yo-self/lexer.yo`, `token.yo`       | Self-hosted lexer (ports of `src/lexer.ts`, `src/token.ts`)                                                                                                                    |
| `yo-self/parser.yo`                  | Self-hosted parser (port of `src/parser.ts`)                                                                                                                                   |
| `yo-self/tests/`                     | Tests for the self-hosted components (~60 files / ~900 tests; see `yo-self/README.md` for tiers & known-heavy files)                                                           |
| `std/build.yo`                       | Build system API (Project, Step, Executable, etc.)                                                                                                                             |
| `src/build-runner.ts`                | Build execution engine — DAG scheduler, artifact compilation                                                                                                                   |
| `src/install-command.ts`             | `yo install` — add git/path dependencies                                                                                                                                       |
| `src/fetch.ts`                       | Git dependency fetching, lock file pruning                                                                                                                                     |
| `src/fetch-command.ts`               | `yo fetch` CLI command                                                                                                                                                         |
| `src/lock-file.ts`                   | `yo.lock` parse/write                                                                                                                                                          |
| `src/cache.ts`                       | Global dependency cache (`~/.cache/yo/deps/`) + version cache helpers                                                                                                          |
| `src/init.ts`                        | `yo init` — project scaffolding                                                                                                                                                |
| `src/version.ts`                     | `.yo-version` discovery, parsing, validation                                                                                                                                   |
| `src/version-cache.ts`               | Version download from npm, cache management, runtime detection                                                                                                                 |
| `src/doc-command.ts`                 | `yo doc` CLI — documentation generation                                                                                                                                        |
| `src/doc/`                           | Doc pipeline: extractor, builder, model, renderers                                                                                                                             |
| `src/pkg-config.ts`                  | pkg-config integration for system libraries                                                                                                                                    |
| `src/dag.ts`                         | DAG builder and level-based scheduler for build steps                                                                                                                          |
| `plans/BUILD_SYSTEM.md`              | Build system design document                                                                                                                                                   |
| `plans/DEPENDENCY_MANAGEMENT.md`     | Dependency management design                                                                                                                                                   |
| `plans/VERSION_MANAGEMENT.md`        | `.yo-version` pinning and version cache design                                                                                                                                 |
| `plans/HIGHER_KINDED_TYPES.md`       | HKT design & implementation (TypeApplication, partial application)                                                                                                             |
| `plans/FUNCTOR_APPLICATIVE_MONAD.md` | Option/Result functional combinators plan                                                                                                                                      |
| `plans/BOOTSTRAPPING.md`             | Bootstrapping roadmap — phases, install scripts, risk assessment                                                                                                               |
| `plans/YO_SELF_EXPRINFO_PRUNE.md`    | REJECTED `yo-self` memory lever: pruning the process-lifetime `ExprInfoTable` (built, measured, refuted)                                                                       |
| `plans/YO_SELF_ENV_SHARING.md`       | The real `yo-self` memory root cause: def-time body envs COPY what TS SHARES (7.4 M live `Variable`s), plus the remaining ranked levers                                        |

### Algebraic effects model

- `return(expr)` inside an effect handler **resumes** the continuation.
- `unwind(expr)` inside an effect handler **discards** the continuation and exits the enclosing `fn`. (Was previously named `escape` — renamed in commit `a3510d20`.)
- When an async task is unwound, the Future enters `FutureState.Aborted` (state = -2).
- C's `abort()` (process termination on panic) is a **different thing** — never confuse the two.

### Async/await threading model

Yo's async/await is **single-threaded** (like C#). All I/O submissions and completions run on one event loop thread. Do not add mutexes or atomics to async runtime variables. The parallelism runtime (`src/codegen/parallelism/`) is a separate multi-threaded concern.

---

## Build & Test Commands

```bash
# Build (always run before yo-cli)
bun run build

# Evaluator tests (TypeScript)
bun test src/tests/fixme.test.ts --timeout 10000

# Build system tests
bun test src/tests/build-system.test.ts --timeout 10000

# C codegen tests — specific file (always use --parallel 1 for single files)
./yo-cli test ./tests/algebraic_effects.test.yo --bail -v --parallel 1

# C codegen tests — specific test by name
./yo-cli test ./tests/algebraic_effects.test.yo --test-name-pattern "Test fn unwind" --parallel 1

# Bootstrap (yo-self) tests — run the file(s) covering what you changed.
# Files importing evaluator internals take 1–10 min each (big Yo-compile).
# MEASURED 2026-08-05 (58 files, --parallel 1): 40.5 min under the TS compiler,
# 22.2 min under the self-hosted binary (it is ~2x faster), 63 min for a
# both-compilers differential. The old "~90 min" figure was pessimistic.
# Run ONE FILE AND ONE COMPILER AT A TIME: phase6c_macro alone needs 6.52 GB, so
# two concurrent children on a 16 GB machine swap, and the swapping trips the
# runner's own 600 s evaluator deadline — MANUFACTURING failures that do not
# reproduce in isolation. Note the self-hosted runner ignores --parallel anyway
# (yo-self/main.yo: "Accepted for CLI compatibility; v1 runs sequentially").
./yo-cli test ./yo-self/tests/lexer.test.yo --parallel 1
./yo-cli test ./yo-self/tests/parser.test.yo --parallel 1
./yo-cli test ./yo-self/tests/ --parallel 2

# Full integration test suite (~30 min on Mac Mini M4, safe to run locally)
./yo-cli test --bail

# Evaluator-only check (fast, no codegen — useful for type-check iteration during refactors)
./yo-cli check ./std
./yo-cli check ./src/tests/fixme.yo

# Emit C only (inspect generated code)
./yo-cli compile src/tests/fixme.yo --emit-c --skip-c-compiler --release

# Full compile + run
./yo-cli compile src/tests/fixme.yo --release -o a.out && ./a.out

# Compile with AddressSanitizer
./yo-cli compile src/tests/fixme.yo --release --sanitize address --allocator libc -o test && ./test
```

Always save verbose output to a file to avoid terminal truncation:

```bash
./yo-cli test file.yo --bail -v &> output.txt
./yo-cli compile src/tests/fixme.yo --release &> compile_output.txt
```

### Windows compatibility

`./yo-cli` is a bash script; it does not work on Windows. Use one of these instead:

```bash
# Option 1: the built JavaScript entry point (works everywhere)
node ./out/cjs/yo-cli.cjs test ./tests --parallel 8 --bail

# Option 2: the PowerShell wrapper (Windows PowerShell)
./yo-cli.ps1 test ./tests --parallel 8 --bail
```

TypeScript test files that shell out to `yo-cli` (`comptime-ref-gate.test.ts`,
`pragma-validation.test.ts`, `unsafe-gate.test.ts`) must use
`execFileSync("node", [YO_CLI, ...])` where `YO_CLI` points to
`out/cjs/yo-cli.cjs`, not the `yo-cli` bash script.

### Build system commands

```bash
# Initialize a new project
./yo-cli init [dir] --name my-project

# Build project (default: install step)
./yo-cli build
./yo-cli build run          # Build and run
./yo-cli build test         # Run tests
./yo-cli build --list-steps # List available steps
./yo-cli build -Dname=value # Pass build options

# Generate documentation
./yo-cli doc ./std           # Generate docs for directory
./yo-cli doc -o ./yo-out/doc # Custom output directory
./yo-cli doc --format json   # Output as JSON (default: html)

# Dependency management
./yo-cli fetch              # Fetch all git dependencies
./yo-cli fetch --update     # Re-resolve refs to latest commits
./yo-cli install user/repo  # Install from GitHub (latest semver tag)
./yo-cli install user/repo@v1.0.0  # Install pinned version
./yo-cli install ./path     # Install local path dependency
./yo-cli cache path         # Print global cache directory
./yo-cli cache clean        # Remove all cached dependencies

# Version management
./yo-cli version            # Show current + pinned version
./yo-cli version pin        # Pin project to current Yo version
./yo-cli version pin 0.1.12 # Pin to specific version
./yo-cli version install 0.1.13  # Pre-download a version
./yo-cli version list       # List cached versions
./yo-cli version list --remote   # List all available npm versions
./yo-cli version clean      # Remove all cached versions
```

---

## Universal Workflow Rules

- Always run `bun run build && ...` to ensure no TypeScript errors before running other `bun` or `./yo-cli` commands.
- Do not use `npm` — only use `bun`.
- Make sure commands run successfully. Don't ask the user to run — run them yourself. Don't end the conversation until the command succeeds.
- Never hardcode any TypeScript or Yo when solving a problem. Always go with a proper implementation. No shortcuts. Don't simplify the problem.
- While implementing the evaluator or codegen, no shortcuts or simplifications!
- Do not create new `.yo`, `.js`, or `.ts` files unless told to do so.
- Never use TypeScript `any` type. Use explicit types or `unknown` with proper narrowing.
- No inline `import(...)` type expressions in TypeScript. Always use top-level `import type { ... }` statements.
- No TypeScript `index.ts` barrel files — they easily cause circular dependencies.
- When asked to refactor, refactor everything. Don't miss any lines. Don't put placeholders or TODOs.
- Never skip bugs discovered during implementation.
- After fixing a bug, verify uncommitted changes for leftover or unused code.
- Always review all uncommitted changes (`git diff`) before considering work done. Check for leftover debug code, unused imports, and consistency across all modified files.
- **Always run `./yo-cli fmt <file.yo>` on every `.yo` file you create or modify, before committing.** Use `./yo-cli fmt --check` to verify. Do not commit unformatted `.yo` files.
- Always check if there is need to create/update existing instructions & rules & skill files, design/plan docs after implementing a change.
- **Whenever you learn something new about Yo syntax, semantics, or common pitfalls — especially from trial and error — immediately update the relevant skill files** (`.github/skills/yo-syntax/syntax-cheatsheet.md`, `.github/skills/yo-core-patterns/core-patterns-cheatsheet.md`, etc.) **and instruction files** (`.github/instructions/yo-syntax.instructions.md`, `.github/instructions/yo-design.instructions.md`). This keeps the institutional knowledge accurate for future sessions.
- Always put design/plan documents in `plans/` directory (e.g., `plans/FEATURE_NAME.md`).
- Always put the issues or bugs you found in `issues/` directory.
- Always add test cases for any bug you found, and verify they fail before fixing the bug. After fixing, verify the new test cases pass and add them to `tests/` test set.
- The full test suite (`./yo-cli test --bail`) takes ~30 minutes on a Mac Mini M4 and is safe to run locally. For faster iteration, run targeted test files instead.
- If you haven't modified the code, don't ask to run commands repeatedly.
- Ignore `DESIGN.md` and other markdown files in `outdated/` — they are out of date.
- No need to read `fixme.test.ts`.
- `src/tests/fixme.yo` is a scratch file for experimentation. There is no need to restore its contents after modifying it.
- When creating or updating docs in `docs/`, always write both English (`docs/en-US/`) and Chinese (`docs/zh-CN/`) versions.
- Use ` ```rust ` (not ` ```yo `) for Yo language code blocks in Markdown files — Rust highlighting renders better on GitHub.

---

## Common Pitfalls

- **`expr.$.value == undefined`** means the value is a runtime value (not `UnknownValue`). `UnknownValue` means the type is known but the value itself is not.
- **`./yo-cli compile` cannot be used on `*.test.yo` files.** Extract the failing test case into a standalone `.yo` file with a `main` function and `export main;`.
- **`index.ts` barrel files cause circular imports.** Never create them in `src/`.
- **Algebraic effect `unwind` vs C `abort()`**: They are completely different. The Yo keyword `unwind` discards a continuation; C's `abort()` terminates the process. (`unwind` was previously named `escape`, renamed in commit `a3510d20`.)
- **VS Code extension errors for `.yo` files** are often stale — the extension may not reflect the latest evaluator. Rebuild with `cd vscode-extension && bun package` if needed.
- **`outdated/` markdown files are stale.** Do not use them for design decisions.
- **yargs `.scriptName("yo")`** is set in `yo-cli.ts` so help text shows `yo` instead of `bun`. Don't remove it.
- **`yo fetch` auto-prunes stale lock entries.** When a dep is removed from `build.yo`, running `yo fetch` removes it from `yo.lock`. Global cache is not auto-cleaned.
- **`GIT_TERMINAL_PROMPT=0`** must be set when running `git ls-remote` on potentially non-existent repos to prevent interactive credential prompts.
- **A `-O0` binary that SIGSEGVs (rc=139) on deep recursion is stack exhaustion, NOT heap corruption — don't chase ASan/malloc.** Compiled Yo programs run `main` on a worker thread whose stack defaults to 1 GiB (`__yo_main_stack` in `src/codegen/functions/generation.ts`) and is overridable at runtime via the `YO_MAIN_STACK_MB` env var. At `-O0` (the default, non-`--release` build) clang gives every temporary its own stack slot, so the big evaluator functions (`evaluate_match` ~9 MB, `evaluate_function_call` ~8 MB) have multi-MB frames; deep compile-time recursion — e.g. `derive(Eq)` over a ~46-variant enum unrolling `__yo_comptime_fold_range` once per variant — then exhausts a 1 GiB stack at ~45 levels (≈22 MB/level). This is why `check ./yo-self` crashed under `is_executing`. **`--release` (-O2, src/codegen/index.ts) shrinks frames ~100× via LLVM stack coloring (only runs at `-O1`+), needing <1 MB/level — it handles 1000+ levels on 1 GiB and never hits this.** So: validate the self-hosted compiler under deep recursion either with `--release`, or keep the fast `-O0` loop and bump the stack: `YO_MAIN_STACK_MB=4096 <binary> check ./yo-self`. Diagnose this class of crash by rc=139 with no ASan output + a sharp deterministic depth threshold (it scales linearly with the stack size). The default is kept at 1 GiB (reserved lazily) so CI runners are not asked to reserve gigabytes.

## Debugging codegen / C compilation issues

When you encounter a C compilation error from `./yo-cli compile`, follow this
workflow:

1. **Document the issue** in `issues/<name>.md` with:
   - The error message (verbatim)
   - A **minimal `.yo` reproducer** (use `src/tests/fixme.yo`)
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
