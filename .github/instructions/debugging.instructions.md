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

## CTFE (Compile-Time Function Evaluation)

See `cfte-analysis.ts`. Yo tries to replace all parameters/return as `comptime` and re-evaluate the function body at compile-time. If it succeeds, the function can be called at compile-time.
