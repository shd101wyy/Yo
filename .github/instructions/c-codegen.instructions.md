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

## Algebraic effects codegen

- Functions with `forall(...(E))` spread effect parameters have generic bodies where sub-expression type info may be missing. Effect analysis for these functions is performed during the codegen phase (in `preRegisterEffectfulFunctions`), not during evaluation.

### Evidence passing for effects

**All** effects — both module-type (e.g., `Exception`, `Raise`) and function-type — use **evidence passing**. A module is a compile-time construct (just a named collection of functions); at runtime, only function pointers exist. Therefore there is no distinction between module effects and function effects in codegen — both compile to passing function pointers as explicit C parameters.

`forall(...)`, `using(...)`, and modules are **compile-time only** constructs — they are erased at runtime. Evidence passing is how their runtime behavior is realized.

**How it works:**
- A function with `using(exn : Exception)` gets an extra C parameter: `void (*throw)(AnyError)`
- A function with `using(raise_mod : Raise)` where `Raise :: module(raise : (fn(msg: String) -> i32))` gets: `int32_t (*raise)(yo_string)`
- The function body calls the effect operation directly via the function pointer — no SM needed
- Call sites pass the function pointer from their context:
  - Sync: the handler function address from `given(exn) := Exception(throw: handler_fn)`
  - Async SM: `sm->__capture.throw` from the Future's capture struct
  - Transitive: forwarded from the caller's own evidence parameter

**Why this is needed:**
- SM-inlining works for sync-only contexts (handler body is inlined at call site)
- But inside `io.async` closures, handler values become runtime function pointers in the capture struct
- A sync effectful function called inside async can't access those captures via the SM mechanism
- Evidence passing is composable across sync/async boundaries because function pointers are runtime values

See `issues/sync-effect-inlining-inside-async-context.md` for the full design rationale.

**Mixed escape+return handlers:**
- A handler may `return` in one branch and `escape` in another. Both paths work with evidence passing:
  - Return path: handler function returns normally; caller uses the resume value
  - Escape path: handler sets `__yo_effect_escaped = 1` and returns a dummy; caller checks the flag and propagates
- Non-unit `escape value` is supported — the escape value is stored in a thread-local and retrieved at the handler installation site.

### When SM is still needed

The SM approach is still needed for **multi-yield resumable effects** where the handler body interleaves with the computation (e.g., deep handlers that resume multiple times from different yield points within the same function body). This is rare in practice; most effects are tail-resumptive.

### Thread-local escape flag

Because effect handlers are called via function pointer (evidence passing), the codegen cannot statically detect whether the handler calls `escape()`. A thread-local flag `__yo_effect_escaped` is used for runtime detection:

1. Before calling a module effect member via function pointer, the flag is reset to 0.
2. If the handler calls `escape()`, the flag is set to 1 (in `generateEscape`, gated by `isModuleEffectMemberFunction`).
3. After the call returns, the caller checks the flag. If set, it drops any RC-typed arguments and propagates the escape:
   - In async SM: aborts the Future (state = -2), spawns the continuation, returns.
   - In sync context (evidence passing): drops locals, returns a dummy value. Each caller in the transitive chain checks the flag and propagates.

Key files: `context.ts` (`isModuleEffectMemberFunction`), `generation.ts` (preamble + context flag), `exprs/generation.ts` (flag set in `generateEscape`), `other-fn-call.ts` (flag check + abort at call site).
