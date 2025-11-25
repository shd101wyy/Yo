import { CodeGenContext } from "../utils";

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
  // Enable POSIX extensions for usleep and other functions
  context.emitter.emitHeaderLine(`#ifndef _WIN32`);
  context.emitter.emitHeaderLine(`#define _DEFAULT_SOURCE`);
  context.emitter.emitHeaderLine(`#endif`);
  context.emitter.emitHeaderLine(``);

  for (const include of context.cIncludes) {
    context.emitter.emitHeaderLine(`#include ${include}`);
  }

  // Add mimalloc compatibility layer
  context.emitter.emitHeaderLine(``);
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
  context.emitter.emitHeaderLine(`  #else`);
  context.emitter.emitHeaderLine(`    #define __yo_malloc malloc`);
  context.emitter.emitHeaderLine(`    #define __yo_calloc calloc`);
  context.emitter.emitHeaderLine(`    #define __yo_realloc realloc`);
  context.emitter.emitHeaderLine(`    #define __yo_free free`);
  context.emitter.emitHeaderLine(
    `    #define __yo_aligned_alloc aligned_alloc`
  );
  context.emitter.emitHeaderLine(`  #endif`);
  context.emitter.emitHeaderLine(`#else`);
  context.emitter.emitHeaderLine(
    `  // Fallback for older compilers without __has_include`
  );
  context.emitter.emitHeaderLine(`  #define __yo_malloc malloc`);
  context.emitter.emitHeaderLine(`  #define __yo_calloc calloc`);
  context.emitter.emitHeaderLine(`  #define __yo_realloc realloc`);
  context.emitter.emitHeaderLine(`  #define __yo_free free`);
  context.emitter.emitHeaderLine(`  #define __yo_aligned_alloc aligned_alloc`);
  context.emitter.emitHeaderLine(`#endif`);
  context.emitter.emitHeaderLine(``);
}
