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

## Important constraints

- You **cannot** `./yo-cli compile` on a `*.test.yo` file. To test a failing test, move the code into a separate `.yo` file with a `main` function and `export main;` at the end.
- Always save test log output: `./yo-cli test src/tests/fixme.test.yo --bail --verbose &> test_output.txt`
- If a `main` linker error appears (`undefined reference to 'main'`), add `export main;` at the end of the `.yo` file.

## File creation rules

- Do not create new `.yo`, `.js`, or `.ts` files unless told to do so.
- You can comment out existing code in `src/tests/fixme.yo` and create new test code there.
