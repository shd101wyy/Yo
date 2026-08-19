---
description: "Use when running tests, setting up test files, or debugging test failures in the Yo compiler. Covers yo test, sanitizers, and test file constraints."
---

# Testing Workflows

> Every command here is the self-hosted compiler `yo`, a native binary from a
> release bundle on your `PATH`. The `./yo-cli` bash shim, the TypeScript
> compiler under `src/`, and the `bun test` suites that exercised it are all
> deleted — there is no bun, npm, or node in this repo outside
> `vscode-extension/`.

## Scratch experiments

- `tmp/fixme.yo` is the scratch file for one-off experiments (`tmp*` is gitignored). It replaces the old `src/tests/fixme.yo`.
- Type-check it with `yo check tmp/fixme.yo`; compile and run it with `yo compile tmp/fixme.yo --release -o a.out && ./a.out`.
- Its contents are disposable — there is no need to restore them after modifying it.

## C codegen tests

- Run specific test: `yo test ./tests/XXX.test.yo` (add `-v` for verbose)
- The **full test suite** (`yo test --bail`) takes ~30 minutes on a Mac Mini M4 and is safe to run locally. Use it for broad regression checks after significant changes.
- `--bail` or `-b` — stop after first failure
- `-v` or `--verbose` — show detailed errors
- `--test-name-pattern "Test XXX"` — run specific test by name
- Tests automatically use AddressSanitizer for leak detection.

## Evaluator-only check (no codegen)

- `yo check <file-or-dir>` — runs the evaluator on a single `.yo` file or every `.yo` under a directory and prints any type / evaluator errors. No C generation, no C compile.
- Much faster than `compile` for "does this still type-check?" iteration during refactors or migrations.
- Useful as a bulk sanity pass after touching many files: `yo check ./yo-self` or `yo check std/` before running any test.
- **`check` is evaluator-only.** The async state-machine restrictions are enforced in CODEGEN, so `check` passes straight over them. Use `yo compile yo-self/main.yo --skip-c-compiler` (~3 min) to catch that class.

## Build system tests

- The build system is covered by `.yo` tests in `tests/internal/`: `build_runner.test.yo`, `lock_file.test.yo`, `target.test.yo`, `fetch.test.yo`, `install_command.test.yo`, `cache.test.yo`, `init.test.yo`, `version.test.yo`.
- Tests cover: build registry, artifacts, steps, DAG, dependencies, lock file, target parsing, path deps, transitive deps.
- Run them like any other internal test: `yo test ./tests/internal/build_runner.test.yo --parallel 1`.
- End-to-end CLI subcommand behaviour is covered separately by the `tests/cli-cases/` corpus.

## A fixpoint run's stage-1 must come from the SAME tree it compiles

`scripts/bootstrap/fixpoint_only.sh` takes a prebuilt stage-1 via `S1=` and has
it compile the tree as it exists **when the script runs**. So editing anything
between building that stage-1 and starting the gate invalidates the result:
stage-2 then carries the edit while stage-1 does not, the two binaries are
different generations, and their emissions legitimately differ.

Measured 2026-08-13: adding one import to `std/process/command.yo` four seconds
before the gate started produced `FIXPOINT_BROKEN` with **1.1 M differing
lines** — while every individual step passed (`STAGE2_RC=0`, `hollow=0`,
`CLANG_RC=0`, `STAGE3_RC=0`). Rebuilding stage-1 from the final tree gave
`FIXPOINT_HOLDS` with no code change at all.

**Read the diff before believing the verdict.** Pure type-id renumbering
(`__yo_t796` → `__yo_t614` with everything shifted) is the signature of a
different COUNT of type instantiations — i.e. generation skew — not a semantic
regression. A real break shows localized, structural differences instead.

This is the same two-generation rule as the seed pin, in a different costume:
anything that changes `std/` shifts every program that links it.

## Compiler internal tests — `tests/internal/`

These are the self-hosted compiler's own tests. **They lived at `yo-self/tests/`
until 2026-08-05**; translate that path when reading older `issues/` and `plans/`
documents. They moved because the TypeScript `src/` was going to be retired and
`yo-self/` renamed to `src/`, so the tests belong under `tests/` rather than
being shuffled again later.

```bash
yo test ./tests/internal --parallel 1        # the whole directory
yo test ./tests/internal/lexer.test.yo --parallel 1
yo test ./tests/internal/parser.test.yo --parallel 1
```

- They import `yo-self/` internals via `../../yo-self/...`, so every file
  that reaches `evaluator/index.yo` pays a full compiler-sized Yo compile.
- **MEASURED 2026-08-05, M4, `--parallel 1`, 58 files:** 22.2 min under the
  self-hosted binary. (The same sweep took 40.5 min under the since-deleted TS
  compiler, and 63 min as a both-compilers differential — historical, no longer
  runnable.)
- **Use `--parallel 1`, and run one at a time.** `macro_expansion` alone
  peaks at ~6.5 GB, so two concurrent children on a 16 GB machine swap — and the
  swapping trips the runner's own 600 s evaluator deadline, MANUFACTURING failures
  that do not reproduce in isolation. (The runner ignores `--parallel`
  regardless: "Accepted for CLI compatibility; v1 runs sequentially".)
- The fast language suite excludes them: `yo test ./tests --exclude tests/internal`.
  CI does the same, and runs `tests/internal` as its own informational job
  (`compiler-internal-tests` in `.github/workflows/test.yml`).
- Run them whenever modifying `yo-self/` source or these tests.
- No WASM directives needed (pure logic, no I/O syscalls) — but they are
  host-toolchain-only in CI, excluded from the emcc and wasm-wasi jobs.
- Large `.test.yo` files are batch-compiled in chunks of 100 tests by default. Use `--test-batch-size N` to tune this when a generated C batch is too large or when you need tighter failure isolation. Smaller batches reduce C size but repeat Yo compilation, so avoid lowering this unless needed.
- Do not run multiple `yo test ...` commands concurrently. The test path currently writes shared scratch files such as `/tmp/yo_self_out.c`, so concurrent runs can collide and produce misleading compile errors or skipped-test counts.

#### A hollow batch voids EVERY test in it, not one

The self-hosted runner inlines **all test bodies of a batch into a single
`__yo_user_main`** (`yo-self/main.yo:1328-1349`, `cond` arms keyed on
`YO_TEST_INDEX`). So one expression codegen cannot transpile turns that whole
function into a `// Failed to transpile` **C comment** — the C compiler skips
it, the binary runs nothing, and the runner reports **every test in the batch as
passing**. Measured 2026-08-12: 23 vacuous tests in
`tests/internal/expr_info.test.yo`, with the CI job green the whole time
(`issues/fixed/yo-self-option-eq-ref-enum-not-specialized.md`).

The `__yo_user_main` marker gate in `yo-self/codegen/functions/generation.yo`
turns this into a hard error. **Never weaken that gate to get a job green.**

Debugging one:

- `YO_KEEP_BATCH=1` keeps `.yo_selftest_batch_<fi>_<bi>.yo` next to the test
  file; compile that directly to iterate instead of re-running the suite.
- To read the marker's text you need a **pre-gate** binary (an older stage-1) —
  with the gate the compile aborts before the `.c` is written.
- Batch bodies are `ast_expr_to_string()` **re-prints**, not source slices, so a
  round-trip defect is a candidate. Rule it out by testing the natural source
  form as well.
- Prefer `opt.is_none()` over `opt == Option(T).None` in tests: the latter needs
  `Eq` on the payload type specialized, which is a much heavier requirement than
  the assertion actually needs.

### macOS 26 AMFI / ASAN dylib workaround

On macOS 26+ (current release), locally-compiled C binaries linked against the
Nix-store ASAN dylib (`libclang_rt.asan_osx_dynamic.dylib`) are rejected by
AMFI/XProtect with "Unrecoverable CT signature issue". The process starts but
never executes; the test runner's 60s watchdog eventually kills it. This
affects ALL branches and ALL test files, including a trivial `assert(true)`.

**Workaround**: pass `--disable-sanitize` to skip AddressSanitizer linkage:

```bash
yo test ./tests/basic.test.yo --disable-sanitize --parallel 1
yo test ./tests/internal --disable-sanitize --parallel 1
```

This disables leak detection on macOS, but tests still validate logic.
See `issues/retired/macos-26-asan-blocked-by-amfi.md` for the kernel-log evidence.

**Alternative** (slower, but keeps ASAN coverage on Linux/WASI): use
`--target wasm-wasi` to run via `wasmtime`:

```bash
yo test ./tests/internal --target wasm-wasi --parallel 1
```

> Note: no file in `tests/internal` carries a `SkipWasm32*` pragma (verified
> 2026-08-05) — the split evaluator files that used to need them are gone. They are
> kept out of the cross-target CI jobs by `--exclude tests/internal` instead, since
> compiling the compiler for a WASM target costs far more than it proves.

The WASM test runner uses Emscripten (`emcc`) with `-sSTANDALONE_WASM` and
`-sINITIAL_MEMORY=67108864` / `-sSTACK_SIZE=8388608` so large test binaries
have sufficient memory.

Tests that spawn sub-processes (e.g., `integration.test.yo`) are automatically
skipped via `pragma(Pragma.SkipWasm32Wasi);` and are not required for CI on affected systems.

### Stack depth limit for yo-self evaluator tests

> **HISTORICAL (2026-08-05).** The specific function measured below,
> `evaluate()` in `yo-self/evaluator/eval.yo`, was RETIRED along with that whole
> legacy proto-evaluator file, and the linker-level stack reserves quoted below
> lived in the since-deleted TypeScript test runner. The **mechanism and the
> platform numbers still apply** to the other large evaluator frames
> (`evaluate_match` ~9 MB, `evaluate_function_call` ~8 MB at `-O0`) — this
> section is kept as the explanation for why deep comptime recursion needs a big
> stack.
>
> **What provides that stack today:** every emitted binary runs its program body
> on a worker thread with a **1 GiB stack by default**, overridable at runtime
> via the `YO_MAIN_STACK_MB` env var (`__yo_main_stack`, emitted by
> `yo-self/codegen/functions/generation.yo`, on both the POSIX and Windows arms).
> WASM keeps a direct call and has no worker stack, so `YO_MAIN_STACK_MB` is a
> no-op there. Nothing sets a linker `-stack_size` / `/STACK:` reserve any more.

The `evaluate()` function in `yo-self/evaluator/eval.yo` had ~2482 local variables
(grown from ~693 in early phases) and occupied **~1.5 MB of stack space per frame**
at `-O0` without ASAN, due to the large `EvalValue`/`TypeValue` enum types stored
directly on the stack. ASAN inflates this further by disabling stack frame reuse
and adding redzones around every variable.

**Per-frame overhead by platform:**

- macOS ARM64 native (no ASAN): ~1.5MB per `evaluate()` frame
- macOS ARM64 with ASAN: ~566KB per `evaluate()` frame (ASAN "fake stack" uses
  separate heap allocation, reducing the real C-stack portion)
- Windows x86_64: ~1.1MB per `evaluate()` frame with ASAN

**macOS ARM64 native (measured against a 256MB reserve, `-Wl,-stack_size,0x10000000`):**

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

**Windows x86_64 (measured against a 16MB reserve, `-Wl,/STACK:16777216`):**

- Safe: countdown(2) needs ~7 frames × 1.1MB ≈ 7.7MB → ✓
- Safe: fact(2) needs ~8 frames × 1.1MB ≈ 8.8MB → ✓
- Unsafe: countdown(3) / fact(3) would exceed 16MB → **STACK OVERFLOW**

When writing recursive evaluator tests, use small inputs (e.g. fib(1), countdown(1)).
Do NOT use `ASAN_OPTIONS=stack_size=N` — that sets the fake stack, not the real C stack.

## Important constraints

- You **cannot** `yo compile` on a `*.test.yo` file. To test a failing test, move the code into a separate `.yo` file with a `main` function and `export(main);` at the end.
- Always save test log output: `yo test ./tests/XXX.test.yo --bail --verbose &> test_output.txt`
- If a `main` linker error appears (`undefined reference to 'main'`), add `export(main);` at the end of the `.yo` file.

## File creation rules

- Do not create new `.js`, or `.ts` files unless told to do so — the repo has no JS/TS toolchain outside `vscode-extension/`.
- You can comment out existing code in `tmp/fixme.yo` and create new test code there.
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

This is the standard pattern from `tests/internal/parser.test.yo`. The struct
constructor `Exception(...)` pins the binding's type, so no annotation is needed
on the LHS.

Prefer `comptime_assert` over `assert` when the value being tested is compile-time known.

## Partial application (`_`) tests

Partial application tests live in `tests/fn.test.yo`. Key facts:

- Partial application with `_` only works on **comptime functions** (return type must be `comptime(...)`)
- It does NOT work on runtime functions or `generic` parameters — use `comptime` parameters instead
- Type constructors like `Result`, `Option` use comptime params and work with `_`
- `fn(generic(A, B, C)) -> comptime(Type)` does NOT support `_` — the partial application counts the original function type's `parameters`, which excludes generic params
- Use `fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type)` for custom type constructors that need `_`

## Formatting

`yo fmt` is the only formatter in the repo — the JS/TS lint and format scripts
(`bun run lint`, `bun run format`, eslint, prettier) went with the TypeScript
tree. The one exception is `vscode-extension/`, which keeps its own npm
toolchain.

- **Always run `yo fmt <files>` on any `.yo` files you create or modify before committing.**
  - To check: `yo fmt --check path/to/file.yo`
  - To fix: `yo fmt path/to/file.yo`
  - Example: `yo fmt tests/internal/formatter.test.yo`

## Slow test files

Some test files contain hundreds of tests and take a long time on their own:

- `tests/string/string.test.yo` — 246 tests, ~8 minutes
- Other large test files may take several minutes

When running a single large file, use `--test-name-pattern` to target individual tests for faster iteration. The full suite (`yo test --bail`) finishes in ~30 minutes total on a Mac Mini M4.

For large generated test binaries, use `--test-batch-size N` to split one `.test.yo` file into smaller generated C binaries. The default is 100 tests per batch.

## WASM testing

- Run a test on Emscripten: `yo test ./tests/XXX.test.yo --cc emcc` (auto-targets `wasm32-emscripten`)
- Run a test on standalone WASI: `yo test ./tests/XXX.test.yo --target wasm-wasi` (runs via `wasmtime`)
- Use `pragma(Pragma.SkipWasm32Emscripten);` to skip a test file on the Emscripten target.
- Use `pragma(Pragma.SkipWasm32Wasi);` to skip a test file on the standalone WASI target.
- Use `pragma(Pragma.SkipWasm);` to skip a test file on ALL WASM targets (generic catch-all).
- Place skip pragmas at the top of the file (within the first 50 lines). A file can have both target-specific pragmas, or the generic one. Pragmas are validated by the evaluator against the `Pragma` enum in `std/prelude.yo`, so typos surface as compile errors.
- For per-test skips, add `{ arch, Arch } :: import("std/process");` and use `if((arch == Arch.Wasm32), return())` at the top of the test body.
- See `plans/WASM_SUPPORT.md` for the full list of WASM-skipped tests and limitations.
- **Errno values differ on WASM** (WASI numbering). Always use constants from `std/libc/errno`, never hardcode errno numbers.
- When adding new tests, verify they pass on native (`yo test ...`), Emscripten (`yo test ... --cc emcc`), and WASI (`yo test ... --target wasm-wasi`), or add appropriate `pragma(Pragma.SkipWasm*);` calls.
- `process.platform` returns `"emscripten"` or `"wasi"` depending on target.
