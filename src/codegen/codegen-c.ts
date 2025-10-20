import { Emitter } from "../emitter";
import { generateModuleId } from "../utils";
import { ModuleValue } from "../value";
import { collectCIncludes, emitCIncludes } from "./c/collection";

// Import the modular components
import { generateDeferredAsyncBlocks } from "./expressions/generation";
import { collectRequiredFunctions } from "./functions/collection";
import { FunctionGenerationContext } from "./functions/context";
import {
  generateAllFunctions,
  generateClosureDisposeFunctions,
  generateFunctionDeclarations,
  generateSpecializedFunctionDeclarations,
  generateSpecializedFunctions,
} from "./functions/generation";
import { collectRequiredTypes } from "./types/collection";
import { generateTypeDeclarations } from "./types/generation";

export class CodeGeneratorC {
  private emitter: Emitter;

  constructor() {
    this.emitter = new Emitter();
  }

  /**
   * Compile a module to C code
   * @param modulePath
   * @param moduleValue
   * @param options
   */
  public compileModule(
    modulePath: string,
    moduleValue: ModuleValue,
    options: {
      debugBrc?: boolean;
      debugConcurrency?: boolean;
      debugAsyncAwait?: boolean;
    } = {}
  ): void {
    this.emitter.emitDeclarationLine(`\n// Module ${modulePath}`);
    this.emitter.emitDeclarationLine(
      `// Module ID: ${generateModuleId(modulePath)}`
    );

    // Create contexts for the modular functions
    const context: FunctionGenerationContext = {
      functions: {},
      externFunctions: {},
      types: {},
      arrayStructTypes: new Map(),
      sliceStructTypes: new Map(),
      spawnedFunctionSignatures: new Map(),
      spawnedClosureSignatures: new Map(),
      closureCaptureMap: new Map(),
      currentFunctionName: "",
      emitter: this.emitter,
      cIncludes: new Set([
        "<stdbool.h>",
        "<stdint.h>",
        "<stddef.h>",
        "<stdarg.h>",
        "<stdatomic.h>",
        "<stdlib.h>",
        "<stdio.h>",
        "<string.h>",
      ]),
      debugBrc: options.debugBrc ?? false,
      debugConcurrency: options.debugConcurrency ?? false,
      debugAsyncAwait: options.debugAsyncAwait ?? false,
      deferredAsyncBlocks: [], // Initialize deferred async blocks array
    };

    // First pass: Collect all functions and types (exported and required by exported functions)
    collectRequiredFunctions(moduleValue, context);
    collectRequiredTypes(moduleValue, context);

    // Collect C includes from variables used in the module
    collectCIncludes(context);

    // Emit C include headers
    emitCIncludes(context);

    // Generate the Future state enum (needed before type declarations)
    this.emitter.emitDeclarationLine(`
// Future state enum - shared by all Future types
typedef enum {
  YO_FUTURE_PENDING = 0,    // Task not started yet (lazy - will start on first await)
  YO_FUTURE_RUNNING = 1,    // Task is in progress (queued or executing)
  YO_FUTURE_COMPLETED = 2,  // Task completed successfully
  YO_FUTURE_ERROR = 3       // Task failed with error
} yo_future_state_t;
`);

    // Second pass: Generate type declarations
    generateTypeDeclarations(context);

    // Third pass: Generate function declarations (prototypes) for regular functions
    generateFunctionDeclarations(context);

    // Fourth pass: Generate all collected functions
    generateAllFunctions(context);

    // Generate deferred async block implementations
    // This must happen after all regular functions are generated to avoid nesting
    generateDeferredAsyncBlocks(context);

    // Generate closure dispose functions after async blocks
    // (async blocks can create closures, so we need to generate after deferred blocks)
    generateClosureDisposeFunctions(context);

    // Fifth pass: Generate declarations for specialized functions (now that they're collected)
    generateSpecializedFunctionDeclarations(context);

    // Sixth pass: Generate the specialized function bodies
    generateSpecializedFunctions(context);
  }

  public print(): string {
    return this.emitter.print();
  }
}
