import { isTargetWindows } from "../../target";
import type { CodeGenContext } from "../utils";

/**
 * Collect C include headers from variables used in the module
 */
export function collectCIncludes(context: CodeGenContext): void {
  // Collect cIncludes from all collected types
  for (const typeId in context.types) {
    const { type } = context.types[typeId]!;
    if (type.cInclude) {
      context.cIncludes.add(type.cInclude);
    }
  }

  // Collect cIncludes from all extern functions
  for (const functionId in context.externFunctions) {
    const { type } = context.externFunctions[functionId]!;

    if (type.cInclude) {
      context.cIncludes.add(type.cInclude);
    }
  }
}

/**
 * Emit C include headers
 */
export function emitCIncludes(context: CodeGenContext): void {
  const isWindows = isTargetWindows(context.targetInfo);

  // Emit platform-specific feature macros
  if (isWindows) {
    context.emitter.emitHeaderLine(`#ifndef WIN32_LEAN_AND_MEAN`);
    context.emitter.emitHeaderLine(`#define WIN32_LEAN_AND_MEAN`);
    context.emitter.emitHeaderLine(`#endif`);
    context.emitter.emitHeaderLine(`#ifndef _WINSOCKAPI_`);
    context.emitter.emitHeaderLine(`#define _WINSOCKAPI_`);
    context.emitter.emitHeaderLine(`#endif`);
  } else {
    context.emitter.emitHeaderLine(`#define _DEFAULT_SOURCE`);
    context.emitter.emitHeaderLine(
      `#define _GNU_SOURCE  // Needed for sched_getcpu() on Linux`
    );
  }
  context.emitter.emitHeaderLine(``);

  // Headers that simply do not exist on the other platform. A registered
  // c_include can leak from a comptime-eliminated platform branch (the
  // type/extern collection walks evaluated module values, e.g. std/env's
  // POSIX `cwd()` arm importing std/libc/unistd even when targeting
  // Windows) — emitting it would be a fatal `file not found`. Any code
  // that genuinely uses these headers is platform-guarded in std, and the
  // guarded block below re-adds the right ones for the actual target.
  const posixOnlyIncludes = new Set(["<unistd.h>", "<dirent.h>"]);
  const windowsOnlyIncludes = new Set(["<windows.h>", "<bcrypt.h>", "<io.h>"]);
  for (const include of context.cIncludes) {
    if (isWindows && posixOnlyIncludes.has(include)) continue;
    if (!isWindows && windowsOnlyIncludes.has(include)) continue;
    context.emitter.emitHeaderLine(`#include ${include}`);
  }

  // Platform-specific includes for file operations
  if (isWindows) {
    context.emitter.emitHeaderLine(`#include <windows.h>`);
    context.emitter.emitHeaderLine(`#include <bcrypt.h>`);
    context.emitter.emitHeaderLine(`#include <io.h>`);
    context.emitter.emitHeaderLine(`#include <sys/stat.h>`);
  } else {
    context.emitter.emitHeaderLine(`#include <unistd.h>`);
    context.emitter.emitHeaderLine(`#include <sys/stat.h>`);
    context.emitter.emitHeaderLine(`#include <sys/random.h>`);
  }

  // Add allocator compatibility layer based on the allocator option
  context.emitter.emitHeaderLine(``);
  if (context.allocator === "mimalloc") {
    context.emitter.emitHeaderLine(
      `// Mimalloc compatibility layer - try mimalloc first, fallback to stdlib`
    );
    context.emitter.emitHeaderLine(`#ifdef __has_include`);
    context.emitter.emitHeaderLine(`  #if __has_include(<mimalloc.h>)`);
    context.emitter.emitHeaderLine(`    #include <mimalloc.h>`);
    context.emitter.emitHeaderLine(`    #define __yo_malloc mi_malloc`);
    context.emitter.emitHeaderLine(`    #define __yo_calloc mi_calloc`);
    context.emitter.emitHeaderLine(`    #define __yo_realloc mi_realloc`);
    context.emitter.emitHeaderLine(`    #define __yo_free mi_free`);
    context.emitter.emitHeaderLine(
      `    #define __yo_aligned_alloc mi_aligned_alloc`
    );
    context.emitter.emitHeaderLine(`    #define __yo_aligned_free mi_free`);
    context.emitter.emitHeaderLine(`  #else`);
    context.emitter.emitHeaderLine(`    #define __yo_malloc malloc`);
    context.emitter.emitHeaderLine(`    #define __yo_calloc calloc`);
    context.emitter.emitHeaderLine(`    #define __yo_realloc realloc`);
    context.emitter.emitHeaderLine(`    #define __yo_free free`);
    if (isWindows) {
      // Windows: _aligned_malloc(size, alignment) has reversed params vs aligned_alloc(alignment, size)
      context.emitter.emitHeaderLine(
        `    static inline void* __yo_aligned_alloc(size_t alignment, size_t size) { return _aligned_malloc(size, alignment); }`
      );
      context.emitter.emitHeaderLine(
        `    #define __yo_aligned_free _aligned_free`
      );
    } else {
      context.emitter.emitHeaderLine(
        `    #define __yo_aligned_alloc aligned_alloc`
      );
      context.emitter.emitHeaderLine(`    #define __yo_aligned_free free`);
    }
    context.emitter.emitHeaderLine(`  #endif`);
    context.emitter.emitHeaderLine(`#else`);
    context.emitter.emitHeaderLine(
      `  // Fallback for older compilers without __has_include`
    );
    context.emitter.emitHeaderLine(`  #define __yo_malloc malloc`);
    context.emitter.emitHeaderLine(`  #define __yo_calloc calloc`);
    context.emitter.emitHeaderLine(`  #define __yo_realloc realloc`);
    context.emitter.emitHeaderLine(`  #define __yo_free free`);
    if (isWindows) {
      context.emitter.emitHeaderLine(
        `  static inline void* __yo_aligned_alloc(size_t alignment, size_t size) { return _aligned_malloc(size, alignment); }`
      );
      context.emitter.emitHeaderLine(
        `  #define __yo_aligned_free _aligned_free`
      );
    } else {
      context.emitter.emitHeaderLine(
        `  #define __yo_aligned_alloc aligned_alloc`
      );
      context.emitter.emitHeaderLine(`  #define __yo_aligned_free free`);
    }
    context.emitter.emitHeaderLine(`#endif`);
  } else {
    context.emitter.emitHeaderLine(`// Using libc allocator`);
    context.emitter.emitHeaderLine(`#define __yo_malloc malloc`);
    context.emitter.emitHeaderLine(`#define __yo_calloc calloc`);
    context.emitter.emitHeaderLine(`#define __yo_realloc realloc`);
    context.emitter.emitHeaderLine(`#define __yo_free free`);
    if (isWindows) {
      context.emitter.emitHeaderLine(
        `static inline void* __yo_aligned_alloc(size_t alignment, size_t size) { return _aligned_malloc(size, alignment); }`
      );
      context.emitter.emitHeaderLine(`#define __yo_aligned_free _aligned_free`);
    } else {
      context.emitter.emitHeaderLine(
        `#define __yo_aligned_alloc aligned_alloc`
      );
      context.emitter.emitHeaderLine(`#define __yo_aligned_free free`);
    }
  }
  context.emitter.emitHeaderLine(``);
}
