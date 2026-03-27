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

| Path                             | Role                                                                  |
| -------------------------------- | --------------------------------------------------------------------- |
| `src/lexer.ts`                   | Tokenizes Yo source into tokens                                       |
| `src/parser.ts`                  | Parses tokens → AST                                                   |
| `src/expr.ts`                    | Core AST node types (`Expr`, `ControlFlowKind`, `BuiltinKeywords`, …) |
| `src/evaluator/`                 | Compile-time evaluator — type checking, CTFE, trait resolution        |
| `src/evaluator/exprs/`           | Per-node evaluation logic (`begin.ts`, `cond.ts`, `escape.ts`, …)     |
| `src/evaluator/calls/`           | Function call specialization and dispatch                             |
| `src/evaluator/effects/`         | Algebraic effects analysis                                            |
| `src/codegen/`                   | C11 code generation                                                   |
| `src/codegen/exprs/`             | Per-node C emitter (`generation.ts`, `return.ts`, `async.ts`, …)      |
| `src/codegen/effects/`           | Effect state machine C emitter                                        |
| `src/codegen/functions/`         | Function-level C emitters                                             |
| `src/types/`                     | Type value definitions and compatibility helpers                      |
| `src/yo-cli.ts`                  | CLI entry point for `yo` / `yo-cli`                                   |
| `std/`                           | Yo standard library (`.yo` source)                                    |
| `tests/`                         | Integration test files (`*.test.yo`)                                  |
| `std/build.yo`                   | Build system API (Project, Step, Executable, etc.)                    |
| `src/build-runner.ts`            | Build execution engine — DAG scheduler, artifact compilation          |
| `src/install-command.ts`         | `yo install` — add git/path dependencies                              |
| `src/fetch.ts`                   | Git dependency fetching, lock file pruning                            |
| `src/fetch-command.ts`           | `yo fetch` CLI command                                                |
| `src/lock-file.ts`               | `yo.lock` parse/write                                                 |
| `src/cache.ts`                   | Global dependency cache (`~/.cache/yo/deps/`)                         |
| `src/init.ts`                    | `yo init` — project scaffolding                                       |
| `src/pkg-config.ts`              | pkg-config integration for system libraries                           |
| `src/dag.ts`                     | DAG builder and level-based scheduler for build steps                 |
| `plans/BUILD_SYSTEM.md`          | Build system design document                                          |
| `plans/DEPENDENCY_MANAGEMENT.md` | Dependency management design                                          |

### Algebraic effects model

- `return expr` inside an effect handler **resumes** the continuation.
- `escape expr` inside an effect handler **discards** the continuation and exits the enclosing `fn`.
- When an async task is escaped, the Future enters `FutureState.Aborted` (state = -2).
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

# C codegen tests — specific file
./yo-cli test ./tests/algebraic_effects.test.yo --bail -v

# C codegen tests — specific test by name
./yo-cli test ./tests/algebraic_effects.test.yo --test-name-pattern "Test escape"

# All integration tests — NEVER run this. It takes over an hour. Always run targeted test files instead.
# ./yo-cli test

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

# Dependency management
./yo-cli fetch              # Fetch all git dependencies
./yo-cli fetch --update     # Re-resolve refs to latest commits
./yo-cli install user/repo  # Install from GitHub (latest semver tag)
./yo-cli install user/repo@v1.0.0  # Install pinned version
./yo-cli install ./path     # Install local path dependency
./yo-cli cache path         # Print global cache directory
./yo-cli cache clean        # Remove all cached dependencies
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
- Always check if there is need to create/update existing instructions & rules files, design/plan docs after implementing a change.
- Never run the full test suite (`./yo-cli test` with no file argument) — it takes over an hour. Always run targeted test files instead.
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
- **Algebraic effect `escape` vs C `abort()`**: They are completely different. The Yo keyword `escape` discards a continuation; C's `abort()` terminates the process.
- **VS Code extension errors for `.yo` files** are often stale — the extension may not reflect the latest evaluator. Rebuild with `cd vscode-extension && bun package` if needed.
- **`outdated/` markdown files are stale.** Do not use them for design decisions.
- **yargs `.scriptName("yo")`** is set in `yo-cli.ts` so help text shows `yo` instead of `bun`. Don't remove it.
- **`yo fetch` auto-prunes stale lock entries.** When a dep is removed from `build.yo`, running `yo fetch` removes it from `yo.lock`. Global cache is not auto-cleaned.
- **`GIT_TERMINAL_PROMPT=0`** must be set when running `git ls-remote` on potentially non-existent repos to prevent interactive credential prompts.
