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
- The **full test suite** (`./yo-cli test --bail`) takes ~30 minutes on a Mac Mini M4 and is safe to run locally. Use it for broad regression checks after significant changes.
- `--bail` or `-b` — stop after first failure
- `-v` or `--verbose` — show detailed errors
- `--test-name-pattern "Test XXX"` — run specific test by name
- Tests automatically use AddressSanitizer for leak detection.

## Build system tests

- Run: `bun test src/tests/build-system.test.ts --timeout 10000`
- Tests cover: BuildRegistry, artifacts, steps, DAG, dependencies, lock file, target parsing, path deps, transitive deps
- Currently 86+ tests
- These are TypeScript unit tests, not `.yo` integration tests

## Bootstrap (yo-self) tests

- Run all: `./yo-cli test ./yo-self/tests/`
- Run lexer only: `./yo-cli test ./yo-self/tests/lexer.test.yo`
- Run parser only: `./yo-cli test ./yo-self/tests/parser.test.yo`
- Run evaluator only: `./yo-cli test ./yo-self/tests/eval.test.yo`
- Currently 180 tests (33 lexer + 36 parser + 15 types/env + 51 evaluator + 45 other), ~7 minutes.
- These are integration tests for `yo-self/` — the self-hosted compiler components.
- Tests import from `yo-self/` with relative paths; no WASM directives needed (pure logic, no I/O syscalls).
- Run these whenever modifying `yo-self/` source or tests.

### ASAN stack depth limit for yo-self evaluator tests

The `evaluate()` function in `yo-self/evaluator/eval.yo` has ~693 local variables.
ASAN disables stack frame reuse and adds redzones around every variable, inflating
each `evaluate()` call from ~7.5KB to **~566KB** per call on ARM64 macOS.

With macOS's 8MB hard stack limit, this means:

- Safe: ≤ 8 simultaneously live `evaluate()` frames (accounting for overhead from `__yo_user_main`, `main`, and `call_funcval_with_args`)
- Unsafe: fib(5) needs ~22 frames × 566KB = 12.5MB → **STACK OVERFLOW**
- Unsafe: countdown(3) needs ~9 frames × 566KB + overhead > 8MB → **STACK OVERFLOW**
- Unsafe: fact(3) needs ~9+ frames × 566KB + overhead > 8MB → **STACK OVERFLOW** (extra frame per level for infix `*`)
- Safe: countdown(2) needs ~7 frames × 566KB ≈ 4MB → ✓
- Safe: fact(2) needs ~6 frames × 566KB ≈ 3.4MB → ✓
- Safe: fib(2) needs ~8 frames × 566KB ≈ 4.5MB → ✓

When writing recursive evaluator tests, use small inputs (e.g. fib(2), countdown(2), fact(2)).
Do NOT use `ASAN_OPTIONS=stack_size=N` — that sets the fake stack, not the real C stack.

## Important constraints

- You **cannot** `./yo-cli compile` on a `*.test.yo` file. To test a failing test, move the code into a separate `.yo` file with a `main` function and `export main;` at the end.
- Always save test log output: `./yo-cli test src/tests/fixme.test.yo --bail --verbose &> test_output.txt`
- If a `main` linker error appears (`undefined reference to 'main'`), add `export main;` at the end of the `.yo` file.

## File creation rules

- Do not create new `.js`, or `.ts` files unless told to do so.
- You can comment out existing code in `src/tests/fixme.yo` and create new test code there.
- If you want to create new `.yo` files, create them in `./tmp` directory under this workspace, not `/tmp`.

## Test syntax

Tests use the `test` keyword with exactly 2 arguments: a name string and a body block.

```rust
test "my test", {
  assert(true, "ok");
};
```

**`io : IO` is automatically injected** into every test body — no `using` clause is needed. All tests can use `io.async(...)`, `io.await(...)`, `io.spawn(...)`, etc. directly:

```rust
test "Async test", {
  task := io.async((using(io : IO))=> {
    io.await(yield());
  });
  io.await(task);
};
```

> **Note:** The old `test "name", using(io : IO), { body }` 3-argument form is no longer supported.

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

Some test files contain hundreds of tests and take a long time on their own:

- `tests/string/string.test.yo` — 246 tests, ~8 minutes
- Other large test files may take several minutes

When running a single large file, use `--test-name-pattern` to target individual tests for faster iteration. The full suite (`./yo-cli test --bail`) runs these in parallel and finishes in ~30 minutes total on a Mac Mini M4.

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
