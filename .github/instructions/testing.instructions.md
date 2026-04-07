---
description: "Use when running tests, setting up test files, or debugging test failures in the Yo compiler. Covers yo-cli test, bun test, sanitizers, and test file constraints."
---

# Testing Workflows

## Evaluator tests (TypeScript)

- Run: `bun test src/tests/fixme.test.ts --timeout 10000`
- Tests the `fixme.yo` file with the Yo evaluator.
- Usually don't modify `fixme.yo` unless told to do so.
- You can comment out existing code in `src/tests/fixme.yo` and create new code there.

## C codegen tests

- Run specific test: `./yo-cli test ./tests/XXX.test.yo --parallel 1` (add `-v` for verbose)
- **Always use `--parallel 1`** when running a single test file — this shows results sequentially and avoids hangs with large test files.
- **Never run the full test suite** (`./yo-cli test` without a file). Always run targeted test files instead.
- `--bail` or `-b` — stop after first failure
- `-v` or `--verbose` — show detailed errors
- `--test-name-pattern "Test XXX"` — run specific test by name
- Tests automatically use AddressSanitizer for leak detection.

## Build system tests

- Run: `bun test src/tests/build-system.test.ts --timeout 10000`
- Tests cover: BuildRegistry, artifacts, steps, DAG, dependencies, lock file, target parsing, path deps, transitive deps
- Currently 86+ tests
- These are TypeScript unit tests, not `.yo` integration tests

## Important constraints

- You **cannot** `./yo-cli compile` on a `*.test.yo` file. To test a failing test, move the code into a separate `.yo` file with a `main` function and `export main;` at the end.
- Always save test log output: `./yo-cli test src/tests/fixme.test.yo --bail --verbose &> test_output.txt`
- If a `main` linker error appears (`undefined reference to 'main'`), add `export main;` at the end of the `.yo` file.

## File creation rules

- Do not create new `.js`, or `.ts` files unless told to do so.
- You can comment out existing code in `src/tests/fixme.yo` and create new test code there.
- If you want to create new `.yo` files, create them in `./tmp` directory under this workspace, not `/tmp`.

## Assertion builtins for Yo tests

- `assert(condition, "message")` — runtime assertion (evaluates at runtime in the compiled C code)
- `comptime_assert(condition, "message")` — compile-time assertion (evaluates during compilation). Use this for testing comptime behavior.
- `comptime_expect_error(expr)` — expects the expression to produce a compile-time error. Use this to test that invalid code is properly rejected.

Prefer `comptime_assert` over `assert` when the value being tested is compile-time known.

## Partial application (`_`) tests

Partial application tests live in `tests/fn.test.yo`. Key facts:

- Partial application with `_` only works on **comptime functions** (return type must be `comptime(...)`)
- It does NOT work on runtime functions or `forall` parameters — use `comptime` parameters instead
- Type constructors like `Result`, `Option` use comptime params and work with `_`
- `fn(forall(A, B, C)) -> comptime(Type)` does NOT support `_` — the partial application checks `origFuncType.parameters.length` which excludes forall params
- Use `fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type)` for custom type constructors that need `_`

## Linting and formatting

- Lint: `bun run lint`
- Format check: `bun run format`
- Fix lint/format issues before committing.

## Slow test files

Some test files contain hundreds of tests and take a very long time to compile and run:

- `tests/string/string.test.yo` — 246 tests, ~8 minutes
- Other large test files may take several minutes

When running these, use longer timeouts and expect extended wait times. For quick iteration, use `--test-name-pattern` to run individual tests instead of the entire file.

## WASM testing

- Run a test on Emscripten: `./yo-cli test ./tests/XXX.test.yo --cc emcc` (auto-targets `wasm32-emscripten`)
- Run a test on standalone WASI: `./yo-cli test ./tests/XXX.test.yo --target wasm-wasi` (runs via `wasmtime`)
- Use `// @skip_wasm32-emscripten` to skip a test file on the Emscripten target.
- Use `// @skip_wasm32-wasi` to skip a test file on the standalone WASI target.
- Use `// @skip_wasm` to skip a test file on ALL WASM targets (generic catch-all).
- A file can have both target-specific directives, or the generic one.
- For per-test skips, add `{ arch, Arch } :: import "std/process";` and use `if((arch == Arch.Wasm32), return ())` at the top of the test body.
- See `plans/WASM_SUPPORT.md` for the full list of WASM-skipped tests and limitations.
- **Errno values differ on WASM** (WASI numbering). Always use constants from `std/libc/errno`, never hardcode errno numbers.
- When adding new tests, verify they pass on native (`./yo-cli test ...`), Emscripten (`./yo-cli test ... --cc emcc`), and WASI (`./yo-cli test ... --target wasm-wasi`), or add appropriate skip directives.
- `process.platform` returns `"emscripten"` or `"wasi"` depending on target.
