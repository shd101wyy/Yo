import type { Expr } from "../expr";
import { Emitter } from "../emitter";
import { getCurrentTarget } from "../target";
import { generateModuleId } from "../utils";
import type { StructValue } from "../value";
import { collectCIncludes, emitCIncludes } from "./c/collection";
import { isStructType, isEnumType } from "../types/guards";
import { canTypeFormRcCycle, typeContainsSomeType } from "../types/utils";
import {
  generateDeferredAsyncBlocks,
  preRegisterAsyncBlockTypes,
} from "./exprs/async";
import {
  collectDisposeMethodsFromGenericImpls,
  collectRequiredFunctions,
  findFunctionCallsInExpr,
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
  emitModuleLevelVariableDeclarations,
  generateLibraryInitFunction,
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
  private _needsIntelAsmSyntax = false;
  private _usesParallelism = false;

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
    moduleValue: StructValue,
    options: {
      debugGc?: boolean;
      debugParallelism?: boolean;
      debugAsyncAwait?: boolean;
      allocator?: "mimalloc" | "libc";
      isLibrary?: boolean;
      allModuleLevelInitExprs?: Expr[];
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
        "<errno.h>",
        "<fcntl.h>", // For O_RDONLY, O_WRONLY, etc.
        // Note: <unistd.h> and <sys/stat.h> are platform-specific, added in emitCIncludes
      ]),
      debugGc: options.debugGc ?? false,
      debugParallelism: options.debugParallelism ?? false,
      debugAsyncAwait: options.debugAsyncAwait ?? false,
      targetInfo: getCurrentTarget(),
      deferredAsyncBlocks: [], // Initialize deferred async blocks array
      allocator: options.allocator ?? "libc",
      isLibrary: options.isLibrary ?? false,
      currentModuleId: generateModuleId(modulePath),
      moduleLevelInitExprs:
        options.allModuleLevelInitExprs ?? moduleValue.moduleLevelInitExprs,
    };

    // First pass: Collect all functions and types (exported and required by exported functions)
    collectRequiredFunctions(moduleValue, context);

    // Also collect functions referenced by module-level mutable variable init expressions
    if (context.moduleLevelInitExprs) {
      for (const initExpr of context.moduleLevelInitExprs) {
        findFunctionCallsInExpr(initExpr, context);
      }
    }

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
  __YO_FUTURE_RUNNING = 0,    // Task is in progress (queued or executing)
  __YO_FUTURE_COMPLETED = 1,  // Task completed successfully
  __YO_FUTURE_ERROR = 2       // Task failed with error
} __yo_future_state_t;
`);

    // Pre-scan: determine if any object type can form RC cycles.
    // This must be computed before generateTypeDeclarations because it affects
    // __yo_ref_header_t layout (with or without GC fields).
    context.needsCycleGC = false;
    for (const typeId in context.types) {
      const { type } = context.types[typeId]!;
      const isCyclableRefStruct =
        isStructType(type) &&
        type.isReferenceSemantics &&
        !type.isAtomicRc &&
        !type.fields.some((field) => typeContainsSomeType(field.type));
      // A reference-semantics enum (`ref(enum(…))`) can also form an RC cycle
      // (e.g. a recursive `Self`-valued variant field), so it is a cycle root too.
      const isCyclableRefEnum =
        isEnumType(type) &&
        type.isReferenceSemantics &&
        !type.isAtomicRc &&
        !type.variants.some((v) =>
          (v.fields ?? []).some((f) => typeContainsSomeType(f.type))
        );
      if (
        (isCyclableRefStruct || isCyclableRefEnum) &&
        canTypeFormRcCycle(type, new Set(), type.env)
      ) {
        context.needsCycleGC = true;
        break;
      }
    }

    // Initialize type-tag dispatch maps (only used when !needsCycleGC)
    if (!context.needsCycleGC) {
      context.disposeTypeIds = new Map();
      context.nextDisposeTypeId = 1;
    }

    // Second pass: Generate type declarations
    generateTypeDeclarations(context);

    // Command-line arguments runtime shim. The argv fat-pointer struct is a
    // local typedef (the builtin Slice type registry no longer exists).
    this.emitter.emitDeclarationLine(`
// Command-line arguments (initialized in main)
typedef struct { uint8_t** data; size_t length; } Slice_uint8_t_u42_;
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

    // Emit module-level mutable variable declarations for BOTH binary and library builds.
    // Libraries need the static declarations even though they don't have main().
    const moduleLevelVars = emitModuleLevelVariableDeclarations(context);

    // Generate main wrapper after deferred async blocks
    // since async main returns a Future type defined in deferred blocks
    // Skip in library mode — libraries don't have a main() entry point
    if (!options.isLibrary) {
      generateMainWrapper(context);
    } else {
      // For library builds, generate __yo_module_init() to initialize module-level vars
      generateLibraryInitFunction(context, moduleLevelVars);
    }

    // Generate closure dispose functions after async blocks
    // (async blocks can create closures, so we need to generate after deferred blocks)
    generateClosureDisposeFunctions(context);

    // Fifth pass: Generate declarations for specialized functions (now that they're collected)
    generateSpecializedFunctionDeclarations(context);

    // Sixth pass: Generate the specialized function bodies
    generateSpecializedFunctions(context);

    // Emit type-tag dispose dispatch function (only when using lightweight RC)
    if (
      !context.needsCycleGC &&
      context.disposeTypeIds &&
      context.disposeTypeIds.size > 0
    ) {
      this.emitter
        .emitLine(`// Type-tag dispatch for dispose — replaces function pointers
// WASM: br_table (~2 cycles) vs call_indirect (~20+ cycles)
static void __yo_dispose_dispatch(void* ptr) {
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  switch (header->type_id) {`);
      for (const [disposeFnName, typeId] of context.disposeTypeIds) {
        this.emitter.emitLine(
          `    case ${typeId}: ${disposeFnName}(ptr); return;`
        );
      }
      this.emitter.emitLine(`    default: return;
  }
}`);
    } else if (!context.needsCycleGC) {
      // No dispose functions registered, but we still need the forward-declared stub
      this.emitter.emitLine(
        `static void __yo_dispose_dispatch(void* ptr) { (void)ptr; }`
      );
    }

    // Propagate codegen flags for C compiler invocation
    if (context.needsIntelAsmSyntax) {
      this._needsIntelAsmSyntax = true;
    }
    if (context.usesParallelism) {
      this._usesParallelism = true;
    }
  }

  public print(): string {
    return this.emitter.print();
  }

  public getExportedFunctionNames(): Set<string> {
    return this.exportedFunctionNames;
  }

  public get needsIntelAsmSyntax(): boolean {
    return this._needsIntelAsmSyntax;
  }

  public get usesParallelism(): boolean {
    return this._usesParallelism;
  }
}
