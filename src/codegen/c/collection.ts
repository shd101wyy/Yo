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
  for (const include of context.cIncludes) {
    context.emitter.emitHeaderLine(`#include ${include}`);
  }
}
