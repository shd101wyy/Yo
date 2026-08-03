---
description: "Use when debugging the Yo evaluator, C codegen output, or runtime issues. Covers gdb, debug print functions, and strategies for diagnosing compiler bugs."
---

# Debugging the Yo Compiler

## Evaluator debugging

Use these functions to print debug information:

- `typeToString` — print types
- `exprToString` — print expressions
- `valueToString` — print values
- `areTypesCompatible` — check type compatibility

Key facts:

- `expr.$.value == undefined` means the value is a **runtime value**, not `UnknownValue`.
- `UnknownValue` is a compile-time value where we only know its type but not the real value.

## GDB for generated C code

- Run `gdb` on `./a.out` to debug generated C code.
- Stick with C11 standard — no GNU extensions.

## Output debugging

- Always use `| head` or `| tail` to limit command output.
- If a command produces no output for a long time, redirect: `./yo-cli compile src/tests/fixme.yo --release &> compile_output.txt`

## Evaluator-only checking

When you only need to surface evaluator/type errors (no codegen, no C compile), use `./yo-cli check <path>`. It runs the evaluator on a single file or every `.yo` file in a directory and prints any errors. Much faster than `compile` for "does this still type-check?" loops, and it's the right tool for bulk migration sanity passes (`./yo-cli check std/` after touching a swathe of files).

## Memory-leak debugging (macOS has no LeakSanitizer)

LeakSanitizer works on Linux but **not on macOS arm64** — an RC leak that fails
CI's ubuntu job with `Direct leak of N byte(s)` is invisible in a local macOS
ASan run. Reproduce locally with the macOS `leaks` tool instead:

```bash
./yo-cli compile repro.yo --release -o repro_bin
leaks --atExit -- ./repro_bin   # "0 leaks for 0 total leaked bytes" = clean
```

For RC-dispose bugs specifically, also read the emitted C: `__yo_decr_rc` only
frees fields when `header->type_id != 0` (or `dispose_fn` under cycle GC), so
check that the type's constructor stamps a dispose id and that
`__yo_dispose_dispatch` has a case that drops the fields
(see `issues/ref-enum-missing-dispose-leak.md` for a worked example).

## Design docs for context

- Compile-time RC ownership: `COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`
- Async/await concurrency: `ASYNC_AWAIT.md`
- Parallelism: `PARALLELISM.md`
- Low-level sys module: `STD_SYS_MODULE.md`
- Algebraic Effects: `ALGEBRAIC_EFFECTS.md`
- Thread-local cycle collector: `CYCLE_COLLECTION.md`

## VS Code extension

- Ignore editor errors for `.yo` files — the extension may not use updated grammar/evaluator code.
- To rebuild: `cd vscode-extension && bun package`

## Debugging regressions with git bisect

When a test fails after a series of commits:

1. First confirm the test passes on `origin/develop`: `git stash && git checkout origin/develop && ./yo-cli test <file> --bail`
2. Use `git bisect` or manually check individual commits to find the first failing commit
3. Read the diff of that commit to understand what changed
4. Embed debug info in **error messages** (not `console.log`) — test workers run in separate processes where stdout is isolated

## Environment frame debugging

The evaluator uses frame-based environments. Key debugging facts:

- `variable.frameLevel` = the frame index where the variable was defined
- `env.frames.length` = total number of frames in the environment
- `functionType.env` captures the env at the function's **definition site** (minus parameters frame)
- `impl.definitionEnv` is captured AFTER `popEnvFrame` removes the generic frame
- The check in `assignment.ts:454-471` compares `variable.frameLevel < functionType.env.frames.length` to detect "variable defined outside function body"
- Frame count mismatches between `functionType.env` and the actual evaluation env cause false positives in this check

## Test file conventions

Each `.test.yo` file has its own import set. Check whether a test file imports `std/fmt` before using `println`:

- Files with `open(import("std/fmt"))` → `println` available
- Files without it → use `assert` only, or add the import
- Match the existing style of the test file when adding new tests
