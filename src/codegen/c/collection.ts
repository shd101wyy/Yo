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

  // Debug: Log extern functions
  console.log(
    "DEBUG: Extern functions collected:",
    Object.keys(context.externFunctions)
  );

  // Collect cIncludes from all extern functions
  for (const functionId in context.externFunctions) {
    const { type } = context.externFunctions[functionId]!;
    console.log(`DEBUG: Extern function ${functionId}:`, {
      cInclude: type.cInclude,
    });
    if (type.cInclude) {
      context.cIncludes.add(type.cInclude);
    }
  }

  console.log("DEBUG: Final cIncludes:", Array.from(context.cIncludes));
}

/**
 * Emit C include headers
 */
export function emitCIncludes(context: CodeGenContext): void {
  for (const include of context.cIncludes) {
    context.emitter.emitHeaderLine(`#include ${include}`);
  }
}
