# Target-Aware C Codegen: Eliminating Platform Macros

## Problem

Today, the Yo compiler emits **all platform variants** into every generated `.c` file, using C preprocessor macros (`#if defined(_WIN32)`, `#if defined(__APPLE__)`, `#if defined(__linux__)`, etc.) to select the correct implementation at C compile time.

For a simple "hello world" program:

- **Total generated C**: ~16,000 lines
- **Platform-specific lines**: ~9,000 (56% of total)
- **Lines eliminable when targeting macOS**: ~7,200 (Linux + Windows code)
- **Lines eliminable when targeting Linux**: ~7,100 (macOS + Windows code)
- **Lines eliminable when targeting Windows**: ~3,600 (Linux + macOS code)

Since the Yo compiler **already knows the target** at compile time (via `--target` flag or host detection in `src/target.ts`), we can emit **only the relevant platform's code**, producing smaller, cleaner C output with zero `#if`/`#ifdef` guards.

## Current State

### Target system (already exists, well-structured)

- `src/target.ts`: `TargetInfo { arch, os, abi, pointerSizeBits, triple }` with parsing, host detection, and convenience functions (`isTargetWindows`, `isTargetLinux`, `isTargetMacos`, `isTargetWasm`)
- `src/codegen/index.ts`: Target is resolved at codegen startup, passed to C compiler via `--target=<clang-triple>`
- `src/evaluator/builtins/process.ts`: `__yo_process_platform()` / `__yo_process_arch()` return comptime strings based on current target
- `std/process.yo`: Exposes `platform`, `arch`, `Platform`, `Arch` for Yo code

### Yo-level platform branching (already optimized)

The evaluator **already eliminates dead branches** in `cond(platform == Platform.X => ...)` at compile time. Only the matching branch's code is evaluated and emitted to C. This means `std/` library files (e.g., `std/sys/constants.yo`, `std/os/env.yo`, `std/crypto/random.yo`) **already produce target-specific C code**. No changes needed there.

### C runtime code (the problem area)

The C runtime (async I/O, threading, GC, parallelism) is emitted as **hardcoded template strings** containing all platform variants with C preprocessor guards. This is where the bloat lives:

| File                                      | Lines | What it protects                                  |
| ----------------------------------------- | ----- | ------------------------------------------------- |
| `src/codegen/async/runtime-io-windows.ts` | 4,091 | IOCP async I/O (Windows only)                     |
| `src/codegen/async/runtime-io-linux.ts`   | 1,761 | io_uring async I/O (Linux only)                   |
| `src/codegen/async/runtime-io-macos.ts`   | 1,713 | kqueue async I/O (macOS only)                     |
| `src/codegen/async/runtime-io-common.ts`  | 1,475 | POSIX file ops + cross-platform helpers           |
| `src/codegen/types/generation.ts`         | 1,330 | Thread sync types (`__YO_THREAD_SYNC_TYPE`, etc.) |
| `src/codegen/functions/generation.ts`     | 1,888 | GC thread cleanup infrastructure                  |
| `src/codegen/async/runtime-core.ts`       | 372   | Event loop core (platform-specific init)          |
| `src/codegen/parallelism/runtime.ts`      | 443   | Worker threads, CPU detection                     |
| `src/codegen/c/collection.ts`             | 107   | Platform-specific `#include` headers              |
| `src/codegen/exprs/inline-fns.ts`         | 227   | Inline platform functions (e.g., sleep)           |

### Classification of C macro usage patterns

**Pattern A — Entire-file platform guard** (easy to migrate):

- `runtime-io-linux.ts`: Entire output wrapped in `#if defined(__linux__) ... #endif`
- `runtime-io-macos.ts`: Entire output wrapped in `#if defined(__APPLE__) ... #endif`
- `runtime-io-windows.ts`: Entire output wrapped in `#if defined(_WIN32) ... #endif`

→ **Migration**: Simply skip calling `generateAsyncRuntimeIO{Linux,MacOS,Windows}` based on target.

**Pattern B — Interleaved platform blocks** (moderate effort):

- `runtime-io-common.ts`: Large `#ifndef _WIN32` block (POSIX-only), plus nested `#if defined(__linux__)` / `#elif defined(__APPLE__)` within
- `runtime-core.ts`: Multiple scattered `#ifdef _WIN32` / `#elif __APPLE__` / `#else` blocks
- `parallelism/runtime.ts`: Thread entry, mutex init, CPU detection, yield — all platform-branched
- `functions/generation.ts`: GC mutex init, TLS key management, process cleanup

→ **Migration**: Refactor template strings into platform-specific variants or use TypeScript-level conditionals.

**Pattern C — Abstraction layer macros** (most complex):

- `types/generation.ts`: Defines `__YO_THREAD_SYNC_TYPE`, `__YO_COND_TYPE`, `__yo_mutex_init`, `__yo_cond_wait`, etc. as C macros that abstract over Windows CRITICAL_SECTION vs pthread_mutex_t

→ **Migration**: Replace C macro abstraction with direct types/calls for the target platform.

**Pattern D — Feature detection** (keep as-is):

- `__has_include(<mimalloc.h>)` — genuine capability probe, not target-dependent
- `_DIRENT_HAVE_D_TYPE` — optional struct member detection
- `__YO_DEBUG_GC`, `__YO_DEBUG_PARALLELISM`, `__YO_DEBUG_ASYNC_AWAIT` — debug flags

→ **No migration needed**. These are not platform macros.

## Proposed Approach

### Phase 1: Low-hanging fruit — skip non-target async I/O runtimes

**Files**: `src/codegen/async/runtime.ts`

Currently `generateAsyncRuntime()` unconditionally calls all three platform-specific generators. Change to:

```typescript
export function generateAsyncRuntime(
  emitter: Emitter,
  targetInfo: TargetInfo,
  _debugAsyncAwait: boolean
): void {
  generateAsyncRuntimeCore(emitter, targetInfo); // needs target-aware refactor

  if (isTargetLinux(targetInfo)) {
    generateAsyncRuntimeIOLinux(emitter);
  } else if (isTargetMacos(targetInfo)) {
    generateAsyncRuntimeIOMacOS(emitter);
  } else if (isTargetWindows(targetInfo)) {
    generateAsyncRuntimeIOWindows(emitter);
  }
  // wasm32: no async I/O runtime needed (or stub)

  generateAsyncRuntimeIOCommon(emitter, targetInfo); // needs target-aware refactor
}
```

**Each platform file** also needs its outer `#if defined(...)` / `#endif` guards stripped, since the TypeScript-level conditional now ensures only the correct one is emitted.

**Estimated impact**: Eliminates ~3,500–7,200 lines of dead C code per compilation.

### Phase 2: Refactor interleaved platform blocks

**Files**: `runtime-io-common.ts`, `runtime-core.ts`, `parallelism/runtime.ts`, `functions/generation.ts`

For each file, refactor the template strings to use TypeScript-level conditionals:

```typescript
// Before (emits all platforms):
emitter.emitLine(`
#if defined(_WIN32)
  Sleep(${ms});
#else
  usleep(${ms} * 1000);
#endif
`);

// After (emits only target platform):
if (isTargetWindows(targetInfo)) {
  emitter.emitLine(`Sleep(${ms});`);
} else {
  emitter.emitLine(`usleep(${ms} * 1000);`);
}
```

For larger blocks (like the POSIX-only section in `runtime-io-common.ts`), split into helper functions:

```typescript
function emitFileExtraOps(emitter: Emitter, targetInfo: TargetInfo): void {
  if (isTargetWindows(targetInfo)) {
    emitWindowsFileExtraOps(emitter);
  } else {
    emitPosixFileExtraOps(emitter, targetInfo); // handles Linux vs macOS differences
  }
}
```

### Phase 3: Replace thread abstraction macros

**File**: `types/generation.ts`

Replace the C macro abstraction layer with direct platform-specific types:

```typescript
// Before: Emits __YO_THREAD_SYNC_TYPE macro that resolves via C preprocessor
// After: Directly emit the concrete type

if (isTargetWindows(targetInfo)) {
  emitter.emitLine(`typedef CRITICAL_SECTION __YO_THREAD_SYNC_TYPE;`);
  // ... or just use CRITICAL_SECTION directly everywhere
} else {
  emitter.emitLine(`typedef pthread_mutex_t __YO_THREAD_SYNC_TYPE;`);
}
```

Or better: eliminate the abstraction macros entirely and emit platform-specific code directly. This would require updating all sites that use `__YO_THREAD_SYNC_*` macros to use the concrete APIs.

### Phase 4: Platform-specific includes

**File**: `c/collection.ts`

Emit only the relevant `#include` directives:

```typescript
if (isTargetWindows(targetInfo)) {
  emitter.emitHeaderLine(`#define WIN32_LEAN_AND_MEAN`);
  emitter.emitHeaderLine(`#include <windows.h>`);
  emitter.emitHeaderLine(`#include <bcrypt.h>`);
  // ...
} else {
  emitter.emitHeaderLine(`#define _DEFAULT_SOURCE`);
  emitter.emitHeaderLine(`#define _GNU_SOURCE`);
  emitter.emitHeaderLine(`#include <unistd.h>`);
  // ...
}
```

## WASM32 Handling

### Question: Should wasm32 use host machine values?

**No.** The wasm32 target should be treated as its own distinct platform, not fall back to the host. Rationale:

1. **Yo already handles this correctly at the Yo level.** `std/process.yo` returns `Platform.Emscripten` / `Platform.Wasi` / `Arch.Wasm32` when the target is `wasm32-emscripten` or `wasm32-wasi`. The evaluator dead-code-eliminates non-WASM branches. This is correct.

2. **The C runtime is the concern.** WASM has no threads, no async I/O (io_uring/kqueue/IOCP), no signals, no fork, etc. The current code "works" because `#if defined(__linux__)` / `#if defined(_WIN32)` / `#if defined(__APPLE__)` all evaluate to false when compiling for wasm32, so the C compiler ignores all platform-specific runtime code.

3. **With target-aware codegen, we must explicitly handle wasm32.** When we stop emitting all platform variants, we need to decide what to emit for wasm32. The answer:

### WASM32 strategy

- **Skip** `generateAsyncRuntimeIOLinux/MacOS/Windows` entirely (no I/O runtime)
- **Skip** parallelism/worker thread runtime (no threads in WASM — `wasm32` has no pthreads or Windows threads)
- **Emit** a minimal stub event loop or WASI-compatible async runtime (future work)
- **Emit** libc-based allocator only (already forced: `const allocator = isWasm ? "libc" : ...`)
- **Skip** GC thread synchronization (single-threaded, no mutex needed)
- **Skip** thread cleanup infrastructure
- **Keep** core data structures (ref counting, RC header, GC cycle collector — these work without threads)

For the **thread sync abstraction macros** (`__YO_THREAD_SYNC_TYPE`, etc.), wasm32 should get **no-op stubs**:

```c
// WASM: No threads, no sync needed
typedef int __YO_THREAD_SYNC_TYPE;  // dummy
#define __YO_THREAD_SYNC_LOCK(m) ((void)0)
#define __YO_THREAD_SYNC_UNLOCK(m) ((void)0)
```

This is actually **more correct** than the current approach, where the C compiler would fail to compile if it tried to use pthread or Windows thread APIs on wasm32.

### Architecture values for wasm32

For architecture-dependent values (pointer size, alignment, endianness):

- **Pointer size**: Already correctly set to 32 bits via `pointerSizeForArch("wasm32") → 32`
- **Endianness**: WASM is little-endian (same as x86_64/aarch64 in practice)
- **No host fallback needed**: WASM has well-defined ABI properties

## Migration Feasibility Assessment

### ✅ Fully feasible (Phase 1)

Skipping non-target async I/O runtimes is a **mechanical change** to `runtime.ts`. The per-platform files already have whole-file guards. Risk: zero — we're just not emitting code that would be `#if 0`'d anyway.

### ✅ Feasible with moderate effort (Phase 2)

Refactoring interleaved blocks requires splitting template strings but is straightforward. The main challenge is `runtime-io-common.ts` which has 33 separate `#if` conditionals across 1,475 lines. Each one needs to be converted to a TypeScript conditional.

**Risk**: Accidentally breaking a platform by missing a conditional. Mitigation: compile test programs on each platform after migration (CI).

### ✅ Feasible but labor-intensive (Phase 3)

Replacing the thread abstraction macros touches ~10 macro definitions and ~50+ usage sites across the runtime. This is the most invasive change but also the cleanest — it eliminates an entire layer of indirection.

**Alternative**: Keep the `__YO_THREAD_SYNC_*` macros but emit only the target's definitions. This is simpler and achieves 90% of the benefit.

### ✅ Trivial (Phase 4)

Platform-specific includes are already partially conditional in `c/collection.ts`. Just expand the pattern.

## Macros That Should Stay

Some C preprocessor usage is **not** platform detection and should remain:

| Macro                                                                 | Reason to keep                                                                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `__has_include(<mimalloc.h>)`                                         | Capability probe — mimalloc may or may not be installed                                                                    |
| `__YO_DEBUG_GC` / `__YO_DEBUG_PARALLELISM` / `__YO_DEBUG_ASYNC_AWAIT` | Debug flags controlled by Yo CLI flags, not platform                                                                       |
| `IORING_OP_FTRUNCATE`                                                 | Feature probe for newer io_uring ops (kernel version dependent)                                                            |
| `#ifndef` guards for POSIX constants on Windows                       | Only relevant when targeting Windows — but in Phase 1+ these entire blocks won't be emitted for non-Windows targets anyway |

## Implementation Order

1. **Phase 1** — Conditional async I/O runtime emission (~1 hour)

   - Change `generateAsyncRuntime()` to accept `TargetInfo`
   - Skip non-target platform runtimes
   - Strip outer `#if`/`#endif` guards from platform files
   - Add wasm32 handling (skip all I/O runtimes)

2. **Phase 2** — Refactor interleaved blocks (~4-6 hours)

   - `runtime-core.ts`: ~15 conditionals
   - `runtime-io-common.ts`: ~33 conditionals (largest)
   - `parallelism/runtime.ts`: ~15 conditionals
   - `functions/generation.ts`: ~10 conditionals
   - `inline-fns.ts`: ~1 conditional

3. **Phase 3** — Thread abstraction macros (~2-3 hours)

   - `types/generation.ts`: Replace macro abstraction with direct platform types
   - Update all usage sites or keep macros but emit only target definitions

4. **Phase 4** — Platform-specific includes (~30 min)
   - `c/collection.ts`: Conditional include emission

### Testing strategy

- After each phase, run the existing test suite: `./yo-cli test ./tests/<relevant>.test.yo`
- Compile a non-trivial program (`--emit-c`) and verify the generated C has no `#if defined(_WIN32)` etc. (for non-Windows targets)
- Cross-compile check: `./yo-cli compile --target x86_64-linux-gnu --emit-c --skip-c-compiler` and verify Linux-only code
- WASM check: `./yo-cli compile --target wasm-emscripten --emit-c --skip-c-compiler` and verify no thread/async runtime

## Expected Outcome

After full migration:

| Target            | Current C lines | Expected C lines | Reduction |
| ----------------- | --------------- | ---------------- | --------- |
| macOS (aarch64)   | ~16,000         | ~8,800           | ~45%      |
| Linux (x86_64)    | ~16,000         | ~8,900           | ~44%      |
| Windows (x86_64)  | ~16,000         | ~12,400          | ~22%      |
| wasm32-emscripten | ~16,000         | ~5,000           | ~69%      |

Windows has the largest platform-specific runtime (IOCP is complex), so it benefits least from eliminating others. WASM benefits most because it needs no I/O runtime, no threads, and no parallelism.

### Secondary benefits

- **Faster C compilation**: Less code for the C compiler to parse (especially clang/gcc with `-O2`)
- **Better C debuggability**: No `#if`/`#ifdef` noise when reading generated code
- **Cleaner cross-compilation**: No risk of C compiler picking wrong platform branch
- **Easier to add new platforms**: Each platform's codegen is isolated in TypeScript, not interleaved in template strings

## Implementation Results

All 4 phases completed. Verified with 203 tests (98 async_await + 57 algebraic_effects + 26 basic + 14 process + 8 closure).

### Actual metrics (macOS target, hello-world program)

| Metric                  | Before | After | Change |
| ----------------------- | ------ | ----- | ------ |
| Total C lines           | 16,041 | 4,204 | −73.8% |
| Preprocessor directives | 264    | 9     | −96.6% |
| Platform `#if`/`#ifdef` | 264    | 0     | −100%  |

The 9 remaining preprocessor directives are debug feature flags (`__YO_DEBUG_GC`, `__YO_DEBUG_PARALLELISM`, `__YO_DEBUG_ASYNC_AWAIT`) — these are intentional, not platform detection.

### Files modified

**Phase 1** — Async I/O runtime conditional emission:

- `src/codegen/utils/index.ts`: Added `targetInfo: TargetInfo` to `CodeGenContext`
- `src/codegen/codegen-c.ts`: Added `targetInfo: getCurrentTarget()` to context
- `src/codegen/async/runtime.ts`: Conditional dispatch to target platform's generator
- `src/codegen/async/runtime-core.ts`: Converted all platform macros to TS conditionals
- `src/codegen/async/runtime-io-{linux,macos,windows}.ts`: Stripped outer platform guards
- `src/codegen/functions/generation.ts`: Updated `generateAsyncRuntime` call

**Phase 2** — Interleaved platform blocks:

- `src/target.ts`: Added `isTargetPosix()` helper
- `src/codegen/exprs/inline-fns.ts`: Converted sleep macro
- `src/codegen/parallelism/runtime.ts`: Converted all 15 platform conditionals
- `src/codegen/functions/generation.ts`: Converted 10 GC platform conditionals
- `src/codegen/async/runtime-io-common.ts`: Converted all 33 platform conditionals (largest single file)

**Phase 3** — Thread abstraction macros:

- `src/codegen/types/generation.ts`: Emit target-specific thread types/macros directly

**Phase 4** — Platform-specific includes:

- `src/codegen/c/collection.ts`: Conditional include emission based on target
