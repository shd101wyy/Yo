---
applyTo: "src/**/codegen/**"
description: "Use when working on C code generation, the codegen transpiler, emitting C code, or fixing C output bugs. Covers C11 standard compliance, emitter patterns, and debugging strategy."
---
# C Codegen Conventions

- Stick with **C11 standard**. Do not use GNU extensions — we target multiple C compilers.
- No `setjmp`/`longjmp` for state machine generation (algebraic effects, async/await).
- Do not call `emitter.emitLine` multiple times when you can use `emitter.emitLine(multi-line string)`.

## Compilation commands

- Emit C only: `./yo-cli compile src/tests/fixme.yo --emit-c --skip-c-compiler --release`
- Compile with clang: `clang -std=c11 -Wall -Wextra a.out.c vendor/mimalloc/src/static.c -Ivendor/mimalloc/include -o ./a.out`
- Add `-luring` on Linux for async IO features.
- On Windows, use `zig` instead of `clang`.
- Full pipeline: `./yo-cli compile src/tests/fixme.yo --release -o a.out && ./a.out`

## Memory allocator options

- `--allocator mimalloc` (default) — high-performance allocation
- `--allocator libc` — standard libc malloc (faster compilation, useful for debugging)

## Memory leak detection

- `--sanitize address` — AddressSanitizer for memory error and leak detection
- `--sanitize leak` — LeakSanitizer for leak detection only
- Example: `./yo-cli compile src/tests/fixme.yo --release --sanitize address --allocator libc -o test && ./test`

## Debug flags

- `--debug-gc` — debug garbage collector and reference counting
- `--debug-parallelism` — debug parallel worker threads
- `--debug-async-await` — debug async/await

## Debugging strategy

If a C codegen bug is very hard to debug from TypeScript, modify the generated C code directly to make it work, document the bugs found, then go back to fix the TypeScript codegen.

When you find a test that causes a C codegen bug, don't weaken the test. Create a new `.yo` file with minimal reproduction code, a `main` function, and `export main;` at the end.

## Reference counting

The `begin.ts` performs reference counting optimization that cancels out dup/drop pairs when possible.

For understanding the compile-time RC ownership model, read `COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`.
