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

## Evaluator-only check (no codegen)

- `./yo-cli check <file-or-dir>` — runs the evaluator on a single `.yo` file or every `.yo` under a directory and prints any type / evaluator errors. No C generation, no C compile.
- Much faster than `compile` for "does this still type-check?" iteration during refactors or migrations.
- Useful as a bulk sanity pass after touching many files: `./yo-cli check std/` to confirm std still type-checks before running any test.

## Build system tests

- Run: `bun test src/tests/build-system.test.ts --timeout 10000`
- Tests cover: BuildRegistry, artifacts, steps, DAG, dependencies, lock file, target parsing, path deps, transitive deps
- Currently 86+ tests
- These are TypeScript unit tests, not `.yo` integration tests

## Bootstrap (yo-self) tests

- Run all: `./yo-cli test ./yo-self/tests/`
- Run lexer only: `./yo-cli test ./yo-self/tests/lexer.test.yo`
- Run parser only: `./yo-cli test ./yo-self/tests/parser.test.yo`
- Run evaluator only: `./yo-cli test ./yo-self/tests/eval_part1.test.yo` (split into parts 1-4)
- Currently ~2010 evaluator tests across `eval_part{1..4}.test.yo`. Each split takes ~5 min Yo→C compile + several min C compile on native. WASM targets are too slow (>10 min Yo compile each, ~6 MB C output) and are skipped via `pragma(Pragma.SkipWasm32*);` calls.
- These are integration tests for `yo-self/` — the self-hosted compiler components.
- Tests import from `yo-self/` with relative paths; no WASM directives needed (pure logic, no I/O syscalls).
- Run these whenever modifying `yo-self/` source or tests.
- Large `.test.yo` files are batch-compiled in chunks of 100 tests by default. Use `--test-batch-size N` to tune this when a generated C batch is too large or when you need tighter failure isolation. Smaller batches reduce C size but repeat Yo compilation, so avoid lowering this unless needed.
- Do not run multiple `./yo-self/yo-self-bin test ...` commands concurrently. The self-hosted test path currently writes shared scratch files such as `/tmp/yo_self_out.c`, so concurrent runs can collide and produce misleading compile errors or skipped-test counts.

### macOS 26 AMFI / ASAN dylib workaround

On macOS 26+ (current release), locally-compiled C binaries linked against the
Nix-store ASAN dylib (`libclang_rt.asan_osx_dynamic.dylib`) are rejected by
AMFI/XProtect with "Unrecoverable CT signature issue". The process starts but
never executes; the test runner's 60s watchdog eventually kills it. This
affects ALL branches and ALL test files, including a trivial `assert(true)`.

**Workaround**: pass `--disable-sanitize` to skip AddressSanitizer linkage:

```bash
./yo-cli test ./tests/basic.test.yo --disable-sanitize --parallel 1
./yo-cli test ./yo-self/tests/ --disable-sanitize --parallel 1
```

This disables leak detection on macOS, but tests still validate logic.
See `issues/macos-26-asan-blocked-by-amfi.md` for the kernel-log evidence.

**Alternative** (slower, but keeps ASAN coverage on Linux/WASI): use
`--target wasm-wasi` to run via `wasmtime`:

```bash
./yo-cli test ./yo-self/tests/ --target wasm-wasi --parallel 1
```

> Note: `eval_part{1..4}.test.yo` carry `pragma(Pragma.SkipWasm32*);` calls because each
> split would take >15 min on WASM (5 min Yo compile + ~10 min emcc on a 6 MB C file).
> Run them natively (with `--disable-sanitize` on macOS) only.

The WASM test runner uses Emscripten (`emcc`) with `-sSTANDALONE_WASM` and
`-sINITIAL_MEMORY=67108864` / `-sSTACK_SIZE=8388608` so large test binaries
have sufficient memory.

Tests that spawn sub-processes (e.g., `integration.test.yo`) are automatically
skipped via `pragma(Pragma.SkipWasm32Wasi);` and are not required for CI on affected systems.

### Stack depth limit for yo-self evaluator tests

The `evaluate()` function in `yo-self/evaluator/eval.yo` has ~2482 local variables
(grown from ~693 in early phases) and occupies **~1.5 MB of stack space per frame**
at `-O0` without ASAN, due to the large `EvalValue`/`TypeValue` enum types stored
directly on the stack. ASAN inflates this further by disabling stack frame reuse
and adding redzones around every variable.

**Per-frame overhead by platform:**

- macOS ARM64 native (no ASAN): ~1.5MB per `evaluate()` frame
- macOS ARM64 with ASAN: ~566KB per `evaluate()` frame (ASAN "fake stack" uses
  separate heap allocation, reducing the real C-stack portion)
- Windows x86_64: ~1.1MB per `evaluate()` frame with ASAN

**macOS ARM64 native (256MB reserve set via `-Wl,-stack_size,0x10000000` in
`src/test-runner.ts`):**

- Safe: countdown(1) needs ~5 frames × 1.5MB ≈ 7.5MB (was SIGSEGV at 8MB default)
- Safe: countdown(10) needs ~50 frames × 1.5MB ≈ 75MB → ✓ with 256MB reserve
- Safe: ack(2,3) needs ~100 frames × 1.5MB ≈ 150MB → ✓ with 256MB reserve
- Unsafe: ack(3,2) needs ~2700+ frames → **STACK OVERFLOW** (too deep for any reasonable stack)

**macOS ARM64 with ASAN (8MB default; --disable-sanitize recommended):**

- Safe: countdown(1) needs ~5 frames × 566KB ≈ 2.8MB → ✓
- Safe: fib(1) needs ~4 frames × 566KB ≈ 2.3MB → ✓
- Unsafe: countdown(2) needs ~7 frames × 566KB ≈ 4MB → **STACK OVERFLOW** (after Phase 3a ExprId growth)
- Unsafe: fact(2) needs ~8 frames × 566KB ≈ 4.5MB → **STACK OVERFLOW**
- Unsafe: fib(5) needs ~22 frames × 566KB > 8MB → **STACK OVERFLOW**

Note: Frame sizes grew significantly after Phase 3a (ExprId added to AstExpr) and Phase 2az
(TraitT extended with new fields). See `issues/asan-eval-frame-size-after-expr-id.md`.

**Windows x86_64 (16MB reserve set via `-Wl,/STACK:16777216` in `src/test-runner.ts`):**

- Safe: countdown(2) needs ~7 frames × 1.1MB ≈ 7.7MB → ✓
- Safe: fact(2) needs ~8 frames × 1.1MB ≈ 8.8MB → ✓
- Unsafe: countdown(3) / fact(3) would exceed 16MB → **STACK OVERFLOW**

When writing recursive evaluator tests, use small inputs (e.g. fib(1), countdown(1)).
Do NOT use `ASAN_OPTIONS=stack_size=N` — that sets the fake stack, not the real C stack.

## Important constraints

- You **cannot** `./yo-cli compile` on a `*.test.yo` file. To test a failing test, move the code into a separate `.yo` file with a `main` function and `export(main);` at the end.
- Always save test log output: `./yo-cli test src/tests/fixme.test.yo --bail --verbose &> test_output.txt`
- If a `main` linker error appears (`undefined reference to 'main'`), add `export(main);` at the end of the `.yo` file.

## File creation rules

- Do not create new `.js`, or `.ts` files unless told to do so.
- You can comment out existing code in `src/tests/fixme.yo` and create new test code there.
- If you want to create new `.yo` files, create them in `./tmp` directory under this workspace, not `/tmp`.

## Test syntax

Tests use the `test` keyword with exactly 2 arguments: a name string and a body block.

```rust
{ assert } :: import("std/assert");
test("my test", {
  assert(true, "ok");
});
```

`assert`/`panic` are NOT prelude-ambient — every test file that uses them
needs `{ assert, panic } :: import("std/assert");` at the top (after any
`pragma(...)` line).

**`io : Io` is automatically bound** inside every test body — no parameter is needed. All tests can use `io.async(...)`, `io.await(...)`, `io.spawn(...)`, etc. directly:

```rust
test("Async test", {
  task := io.async((io : Io) => {
    io.await(yield(), io);
  });
  io.await(task, io);
});
```

> **Note:** The old `test "name", using(io : Io), { body }` 3-argument form is no longer supported.

## Assertion builtins for Yo tests

- `assert(condition, "message")` — runtime assertion (evaluates at runtime in the compiled C code); requires `{ assert } :: import("std/assert");`. The message accepts any `ToString` type; `assert(condition)` uses the default message.
- `comptime_assert(condition, "message")` — compile-time assertion (evaluates during compilation). Use this for testing comptime behavior.
- `comptime_expect_error(expr)` — expects the expression to produce a compile-time error. Use this to test that invalid code is properly rejected.

`assert(condition, msg)` accepts any `msg` implementing `ToString` — plain
`str` literals, template strings, integers, etc. all work:

```rust
assert(false, `unexpected: ${value}`);
assert(false, "unexpected");
```

For a diverging panic in a VALUE-position match/cond arm (the arm must yield
`T`), use the builtin `__yo_panic("...")` — `std/assert`'s `panic` returns
`unit` and cannot adopt the sibling arm's type.

## Exception effect in yo-self tests

When testing a function that takes an `exn : Exception` parameter, build the handler
locally and pass it in:

```rust
test("my test", {
  exn := Exception(throw : ((err) -> { assert(false, "unexpected error"); unwind(()); }));
  result := my_function_that_throws(exn);
  // ...
});
```

This is the standard pattern from `yo-self/tests/parser.test.yo`. The struct
constructor `Exception(...)` pins the binding's type, so no annotation is needed
on the LHS.

Prefer `comptime_assert` over `assert` when the value being tested is compile-time known.

## Partial application (`_`) tests

Partial application tests live in `tests/fn.test.yo`. Key facts:

- Partial application with `_` only works on **comptime functions** (return type must be `comptime(...)`)
- It does NOT work on runtime functions or `generic` parameters — use `comptime` parameters instead
- Type constructors like `Result`, `Option` use comptime params and work with `_`
- `fn(generic(A, B, C)) -> comptime(Type)` does NOT support `_` — the partial application checks `origFuncType.parameters.length` which excludes generic params
- Use `fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type)` for custom type constructors that need `_`

## Linting and formatting

- Lint: `bun run lint`
- Format check: `bun run format`
- Fix lint/format issues before committing.
- **Always run `./yo-cli fmt <files>` on any `.yo` files you create or modify before committing.**
  - To check: `./yo-cli fmt --check path/to/file.yo`
  - To fix: `./yo-cli fmt path/to/file.yo`
  - Example: `./yo-cli fmt yo-self/tests/eval_5v_1.test.yo`

## Slow test files

Some test files contain hundreds of tests and take a long time on their own:

- `tests/string/string.test.yo` — 246 tests, ~8 minutes
- Other large test files may take several minutes

When running a single large file, use `--test-name-pattern` to target individual tests for faster iteration. The full suite (`./yo-cli test --bail`) runs these in parallel and finishes in ~30 minutes total on a Mac Mini M4.

For large generated test binaries, use `--test-batch-size N` to split one `.test.yo` file into smaller generated C binaries. The default is 100 tests per batch.

## WASM testing

- Run a test on Emscripten: `./yo-cli test ./tests/XXX.test.yo --cc emcc` (auto-targets `wasm32-emscripten`)
- Run a test on standalone WASI: `./yo-cli test ./tests/XXX.test.yo --target wasm-wasi` (runs via `wasmtime`)
- Use `pragma(Pragma.SkipWasm32Emscripten);` to skip a test file on the Emscripten target.
- Use `pragma(Pragma.SkipWasm32Wasi);` to skip a test file on the standalone WASI target.
- Use `pragma(Pragma.SkipWasm);` to skip a test file on ALL WASM targets (generic catch-all).
- Place skip pragmas at the top of the file (within the first 50 lines). A file can have both target-specific pragmas, or the generic one. Pragmas are validated by the evaluator against the `Pragma` enum in `std/prelude.yo`, so typos surface as compile errors.
- For per-test skips, add `{ arch, Arch } :: import("std/process");` and use `if((arch == Arch.Wasm32), return())` at the top of the test body.
- See `plans/WASM_SUPPORT.md` for the full list of WASM-skipped tests and limitations.
- **Errno values differ on WASM** (WASI numbering). Always use constants from `std/libc/errno`, never hardcode errno numbers.
- When adding new tests, verify they pass on native (`./yo-cli test ...`), Emscripten (`./yo-cli test ... --cc emcc`), and WASI (`./yo-cli test ... --target wasm-wasi`), or add appropriate `pragma(Pragma.SkipWasm*);` calls.
- `process.platform` returns `"emscripten"` or `"wasi"` depending on target.
