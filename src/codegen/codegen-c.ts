import { Emitter } from "../emitter";
import { generateModuleId } from "../utils";
import type { ModuleValue } from "../value";
import { collectCIncludes, emitCIncludes } from "./c/collection";
import {
  generateDeferredAsyncBlocks,
  preRegisterAsyncBlockTypes,
} from "./exprs/async";
import {
  collectDisposeMethodsFromGenericImpls,
  collectRequiredFunctions,
} from "./functions/collection";
import type { FunctionGenerationContext } from "./functions/context";
import {
  generateFunctionDeclarations,
  generateSpecializedFunctionDeclarations,
} from "./functions/declarations";
import {
  generateDynBoxFunctions,
  generateDynDupDrop,
  generateDynVtables,
  generateDynWrapperFunctions,
} from "./functions/dyn";
import {
  generateAllFunctions,
  generateClosureDisposeFunctions,
  generateMainWrapper,
  generateSpecializedFunctions,
  preRegisterEffectfulFunctions,
} from "./functions/generation";
import { collectRequiredTypes } from "./types/collection";
import {
  generateDynBoxTypes,
  generateTypeDeclarations,
} from "./types/generation";
import { fixupDynImplKeys } from "./utils/fixup";

export class CodeGeneratorC {
  private emitter: Emitter;
  private exportedFunctionNames: Set<string> = new Set();

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
      debugGc?: boolean;
      debugParallelism?: boolean;
      debugAsyncAwait?: boolean;
      allocator?: "mimalloc" | "libc";
      isLibrary?: boolean;
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
      sliceStructTypes: new Map([
        // Always include slice type for command-line arguments (__yo_args)
        ["Slice_uint8_t_u42_", { childType: "uint8_t*" }],
      ]),
      spawnedFunctionSignatures: new Map(),
      spawnedClosureSignatures: new Map(),
      closureCaptureMap: new Map(),
      implClosureCallMap: new Map(),
      dynImpls: new Map(),
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
        "<fcntl.h>", // For O_RDONLY, O_WRONLY, etc.
        // Note: <unistd.h> and <sys/stat.h> are platform-specific, added in emitCIncludes
      ]),
      debugGc: options.debugGc ?? false,
      debugParallelism: options.debugParallelism ?? false,
      debugAsyncAwait: options.debugAsyncAwait ?? false,
      deferredAsyncBlocks: [], // Initialize deferred async blocks array
      allocator: options.allocator ?? "mimalloc",
      isLibrary: options.isLibrary ?? false,
      currentModuleId: options.isLibrary
        ? generateModuleId(modulePath)
        : undefined,
    };

    // First pass: Collect all functions and types (exported and required by exported functions)
    collectRequiredFunctions(moduleValue, context);
    collectRequiredTypes(moduleValue, context);

    // Store exported function names for library mode
    if (options.isLibrary && context.exportedFunctionLabels) {
      for (const [funcId] of context.exportedFunctionLabels) {
        const entry = context.functions[funcId];
        if (entry) {
          this.exportedFunctionNames.add(entry.cName);
        }
      }
    }

    // Collect dispose methods from generic impls for all collected types
    // This is needed because ___dispose functions may need to call user's dispose methods
    // that are defined via generic impls like: impl(forall(T : Type), ArrayList(T), Dispose(...))
    collectDisposeMethodsFromGenericImpls(context);

    // Collect C includes from variables used in the module
    collectCIncludes(context);

    // Emit C include headers
    emitCIncludes(context);

    // Generate the Future state enum (needed before type declarations)
    this.emitter.emitDeclarationLine(`
// Future state enum - shared by all Future types
typedef enum {
  YO_FUTURE_RUNNING = 0,    // Task is in progress (queued or executing)
  YO_FUTURE_COMPLETED = 1,  // Task completed successfully
  YO_FUTURE_ERROR = 2       // Task failed with error
} yo_future_state_t;
`);

    // Second pass: Generate type declarations
    generateTypeDeclarations(context);

    // Command-line arguments (declared after types so Slice type is available)
    this.emitter.emitDeclarationLine(`
// Command-line arguments (initialized in main)
static int32_t __yo_argc;
static uint8_t** __yo_argv;
static Slice_uint8_t_u42_ __yo_args;
`);

    // Fix up dyn impl keys now that types have C names
    fixupDynImplKeys(context);

    // Generate dyn box types
    generateDynBoxTypes(context);

    // Pre-register async block state machine types before generating function declarations
    // This ensures function prototypes use the correct state machine struct names
    preRegisterAsyncBlockTypes(context);

    // Third pass: Generate function declarations (prototypes) for regular functions
    generateFunctionDeclarations(context);

    // Pre-register effectful functions (SM structs + forward declarations)
    // This must run before any function bodies are generated, so that call sites
    // can find effectStateMachineInfo when generating calls to effectful functions.
    preRegisterEffectfulFunctions(context);

    // Fourth pass: Generate all collected functions
    generateAllFunctions(context);

    // Generate dyn box functions
    generateDynBoxFunctions(context);

    // Generate dyn wrapper functions
    generateDynWrapperFunctions(context);

    // Generate dyn vtables
    generateDynVtables(context);

    // Generate dyn dup/drop functions
    generateDynDupDrop(context);

    // Generate deferred async block implementations
    // This must happen after all regular functions are generated to avoid nesting
    generateDeferredAsyncBlocks(context);

    // Generate main wrapper after deferred async blocks
    // since async main returns a Future type defined in deferred blocks
    // Skip in library mode — libraries don't have a main() entry point
    if (!options.isLibrary) {
      generateMainWrapper(context);
    }

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

  public getExportedFunctionNames(): Set<string> {
    return this.exportedFunctionNames;
  }
}
