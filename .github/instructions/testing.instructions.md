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

- Run specific test: `./yo-cli test ./tests/XXX.test.yo` (add `-v` for verbose)
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

## Linting and formatting

- Lint: `bun run lint`
- Format check: `bun run format`
- Fix lint/format issues before committing.

## WASM testing

- Run a test on WASM: `./yo-cli test ./tests/XXX.test.yo --cc emcc` (auto-targets `wasm32-emscripten`)
- Use `// @skip_wasm` as the first line to skip an entire test file on WASM.
- For per-test skips, use `if((arch == Arch.Wasm32), return ())` at the top of the test body.
- See `plans/WASM_SUPPORT.md` for the full list of WASM-skipped tests and limitations.
- **Errno values differ on WASM** (WASI numbering). Always use constants from `std/libc/errno`, never hardcode errno numbers.
- When adding new tests, verify they pass on both native (`./yo-cli test ...`) and WASM (`./yo-cli test ... --cc emcc`), or add appropriate skip guards.
- `process.platform` returns `"emscripten"` on WASM (use `Platform.Emscripten` for platform checks).
