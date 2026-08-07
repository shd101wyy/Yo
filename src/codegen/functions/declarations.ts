import {
  typeImplementsFn,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import type { Expr } from "../../expr";
import type { FuncValueId } from "../../function-value";
import type {
  FunctionParameter,
  FunctionType,
  SourceNamespaceType,
  SomeType,
  Type,
} from "../../types/definitions";
import {
  isFunctionType,
  isEnumType,
  isFunctionTypeGeneric,
  isFunctionTypeHardGeneric,
  isSourceNamespaceType,
  isSomeType,
  isStructType,
  isUnitType,
} from "../../types/guards";
import {
  typeContainsSomeType,
  typeContainsSomeTypeForCodegenParam,
  typeToString,
} from "../../types/utils";
import {
  type CodeGenContext,
  findReturnedAsyncBlock,
  getTypeString,
  isComptimeFunction,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
  sanitizeForCIdentifier,
} from "../utils";
import type { FunctionGenerationContext } from "./context";

// Functions that are either C preprocessor macros or static functions defined
// in the runtime preamble. We must NOT emit `extern` declarations for these —
// macros would expand to conflicting declarations, and static functions would
// conflict with an `extern` linkage specifier.
const THREADING_MACRO_FUNCTIONS = new Set([
  "__yo_mutex_init",
  "__yo_mutex_destroy",
  "__yo_mutex_lock",
  "__yo_mutex_unlock",
  "__yo_cond_init",
  "__yo_cond_destroy",
  "__yo_cond_wait",
  "__yo_cond_signal",
  "__yo_cond_broadcast",
  "__yo_thread_join",
  "__yo_thread_self",
]);

/**
 * Generate function declarations (prototypes)
 */
export function generateFunctionDeclarations(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  emitter.emitDeclarationLine(`// Function declarations`);

  // Generate declarations for extern functions first
  emitter.emitDeclarationLine(`/// Extern functions`);
  for (const key in context.externFunctions) {
    const { cName, type } = context.externFunctions[key]!;
    if (type.isExtern === "yo") {
      // Skip functions that are actually C preprocessor macros
      if (THREADING_MACRO_FUNCTIONS.has(cName)) {
        continue;
      }
      // Generate extern declaration for Yo-language extern functions
      // These reference functions exported from other Yo modules (static libraries)
      generateFunctionDeclaration(type, cName, true, context);
      continue;
    }
    if (type.isExtern === "c" && type.cInclude) {
      continue; // C extern types with cInclude are defined in header files, no need to generate extern declarations
    }
    // Skip GCC/Clang atomic builtins - the compiler already knows about them
    if (cName.startsWith("__atomic_") || cName.startsWith("__sync_")) {
      continue;
    }
    generateFunctionDeclaration(type, cName, true, context);
  }
  emitter.emitDeclarationLine("");

  // Generate forward declarations for async runtime functions (only when async is used)
  if (context.usesAsync) {
    emitter.emitDeclarationLine(`/// Async runtime functions`);
    emitter.emitDeclarationLine(
      `static void __yo_async_spawn_task(void (*resume_fn)(void*), void* state_machine);`
    );
    emitter.emitDeclarationLine("");
  }

  // Generate constructor functions for objects
  emitter.emitDeclarationLine(`/// Object constructors`);
  generateObjectConstructorDeclarations(context);
  emitter.emitDeclarationLine("");

  // Generate constructor functions for closures
  emitter.emitDeclarationLine(`/// Closure constructors`);
  generateClosureConstructorDeclarations(context);
  emitter.emitDeclarationLine("");

  // Generate capture dispose function declarations
  emitter.emitDeclarationLine(`/// Capture dispose functions`);
  generateCaptureDisposeFunctionDeclarations(context);
  emitter.emitDeclarationLine("");

  // Generate constructor functions for dyn types
  emitter.emitDeclarationLine(`/// Dyn type constructors`);
  emitter.emitDeclarationLine("");

  // Generate declarations for other functions
  emitter.emitDeclarationLine(`/// Regular functions`);
  for (const funcId in context.functions) {
    const { cName, value } = context.functions[funcId]!;

    const isUserMain = cName === "__yo_user_main";

    // Check if this function's body has effect analysis (it uses algebraic effects).
    // If so, its function-typed implicit parameters are effect handlers that are resolved
    // by the effect system at the call site — they are NOT truly unresolved.
    const bodyEffectAnalysis = value.body?.$?.effectAnalysis;
    const isEffectfulFunction =
      bodyEffectAnalysis && bodyEffectAnalysis.hasEffects;

    // Skip the original (unspecialized) function when it has specialization caches.
    // The specialized versions handle codegen. The original body was evaluated
    // generically and sub-expressions may lack type annotations.
    // Exception: isEffectRecordMember functions (e.g., Exception.throw generic handlers)
    // MUST still be emitted in their unspecialized form — their body is simple (escape)
    // and the unspecialized name is stored as a void* function pointer in async capture
    // structs by emitEffectRecordInjection in await.ts.
    //
    // Second exception: if the base's cName is still referenced by at least one
    // call site emitted into the C output (the call-site codegen uses
    // `context.functions[funcId].cName`, which is the base's name when no
    // matching specialized FunctionValue is registered in `context.functions`),
    // skipping the base leaves those call sites unresolved. Detect this by
    // checking whether any *registered* specialized FunctionValue shares the
    // base's cName — in that case the specialized entry has replaced the base
    // and we can safely skip; otherwise emit the base declaration too.
    if (
      !isUserMain &&
      !value.type.isClosure &&
      !value.isEffectRecordMember &&
      value.specializedFunctionCaches?.length > 0
    ) {
      const baseCName = cName;
      const hasRegisteredReplacement = Object.values(context.functions).some(
        (entry) =>
          entry !== context.functions[funcId] && entry.cName === baseCName
      );
      if (hasRegisteredReplacement) {
        continue;
      }
    }

    // Check if the function has evidence params (from resolved spread implicits)
    const functionTypeForCheck = value.specializedType ?? value.type;
    const hasEvidenceParams =
      getEvidenceParameters(functionTypeForCheck).length > 0;

    // Io async state machine closures are generated via the deferred async
    // block system, not as standalone declarations.
    if (!isUserMain && value.isIoAsyncStateMachineClosure) {
      continue;
    }

    // A specialization entry (value.specializedType present, no further specializations
    // hanging off it) is concrete at the C ABI even though value.type is the original
    // generic type. Without this carve-out, the hard-generic skip below would drop
    // both the base AND its specialization, leaving call sites that reference the
    // specialized cName with no matching declaration.
    const isConcreteSpecialization =
      !!value.specializedType &&
      (value.specializedFunctionCaches?.length ?? 0) === 0;

    if (
      !isUserMain &&
      !isEffectfulFunction &&
      !hasEvidenceParams &&
      !value.isEffectRecordMember &&
      !isConcreteSpecialization &&
      ((isFunctionTypeHardGeneric(value.type) && !value.type.isClosure) ||
        (value.specializedFunctionCaches?.length > 0 &&
          !value.type.isClosure) ||
        isComptimeFunction(value) ||
        isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(value) ||
        value.isIoAsyncStateMachineClosure)
    ) {
      continue;
    }

    // Skip functions with SomeType in parameters (truly generic)
    // Or with SomeType in return type that isn't a plain Impl(...) or Impl(Future)
    // Use specializedType if available, otherwise use type
    const functionType = value.specializedType ?? value.type;
    // Mirror the carve-out from generation.ts: closures are per-
    // instance with their own concrete capture struct and distinct C
    // function name. Their parameter list may contain `io : Io`
    // whose nested fn-pointer fields trip `typeContainsSomeType`,
    // but the closure value itself is not truly generic. Without
    // the carve-out, the forward declaration is missing while the
    // body IS emitted (per generation.ts), causing
    // "call to undeclared function" / "static declaration follows
    // non-static declaration" errors when the spawn-wrapper calls
    // the closure earlier in the file than its definition site.
    const hasGenericParams =
      !isUserMain &&
      !isEffectfulFunction &&
      !value.isEffectRecordMember &&
      !value.type.isClosure &&
      (functionType.parameters.some((p) =>
        typeContainsSomeTypeForCodegenParam(p.type)
      ) ||
        functionType.forallParameters.length > 0);
    // Mirror the parameter check: a return type of `IoExn` (a struct
    // whose SomeType content only lives inside nested fn-pointer fields)
    // is concrete at the C ABI and should not flag the function as
    // generic. Without this, `fn(..., exn : Exception) -> IoExn`
    // declarations are skipped and call sites reference the undeclared
    // function name.
    const hasGenericReturnType = typeContainsSomeTypeForCodegenParam(
      functionType.return.type
    );

    // Allow functions returning plain Impl(...) existential types (SomeType at top level)
    // These are not truly generic - the concrete type is determined from the function body
    const returnsPlainImpl =
      isSomeType(functionType.return.type) &&
      functionType.return.type.requiredTraits.length > 0;

    if (
      hasGenericParams ||
      (hasGenericReturnType && !returnsPlainImpl && !value.isEffectRecordMember)
    ) {
      continue;
    }

    generateFunctionDeclaration(
      functionType,
      cName,
      false,
      context,
      // Don't pass body for effect record members — their body type (from escape())
      // may not match the function signature's return type. The signature type
      // (even if SomeType → void) is used consistently in both declaration and definition.
      value.isEffectRecordMember ? undefined : value.body,
      // Pass original type so evidence params are detected when specialization
      // strips implicit parameters (e.g., for generic effects).
      // Only do this when specializedType has no evidence but the original does,
      // AND the original has generic function evidence params (which need void* passing).
      // Non-generic using params are resolved at specialization time and don't need this.
      value.specializedType &&
        getEvidenceParameters(functionType).length === 0 &&
        getEvidenceParameters(value.type).some(
          (ep) =>
            ep.fieldFunctionType.forallParameters &&
            ep.fieldFunctionType.forallParameters.length > 0
        )
        ? value.type
        : undefined
    );
  }

  // Generate vtable instance declarations for closures (after function declarations)
  emitter.emitDeclarationLine(`/// Closure vtable instances`);
  generateClosureVtableDeclarations(context);
  emitter.emitDeclarationLine("");
}

/**
 * Evidence parameter — representsan effect record member that becomes
 * an explicit C function pointer parameter via evidence passing.
 */
export interface EvidenceParameter {
  /** The label of the implicit parameter (e.g., "raise_mod") */
  implicitLabel: string;
  /** The field label within the module (e.g., "raise" or "errors__raise" for nested) */
  fieldLabel: string;
  /** Path of field labels for navigating nested evidence records (e.g., ["errors", "raise"]) */
  fieldPath: string[];
  /** The function type of the evidence field */
  fieldFunctionType: FunctionType;
  /** The C parameter name: sanitized "{implicitLabel}_{fieldLabel}" (e.g., "raise_mod__raise") */
  cParamName: string;
}

/**
 * Extract evidence parameters from a function type's implicit parameters.
 * For each implicit param of SourceNamespaceType, emits one EvidenceParameter per
 * function-typed field in the module, recursing into nested modules.
 */
export function getEvidenceParameters(
  _functionType: FunctionType
): EvidenceParameter[] {
  const result: EvidenceParameter[] = [];
  const allImplicits = expandImplicitParameters([] as FunctionParameter[]);

  for (const implicit of allImplicits) {
    if (isSourceNamespaceType(implicit.type) || isStructType(implicit.type)) {
      collectEvidenceFromRecord(
        implicit.label,
        implicit.type as SourceNamespaceType,
        [],
        result
      );
    } else if (isFunctionType(implicit.type)) {
      // Bare function effect — treat as single-field evidence
      // Forall function types are passed as void* and cast at each call site
      result.push({
        implicitLabel: implicit.label,
        fieldLabel: implicit.label,
        fieldPath: [implicit.label],
        fieldFunctionType: implicit.type,
        cParamName: sanitizeForCIdentifier(implicit.label),
      });
    }
  }
  return result;
}

/**
 * Recursively collect evidence parameters from an effect record type.
 * For function-typed fields, creates an EvidenceParameter.
 * For record-typed fields, recurses into the nested record.
 */
function collectEvidenceFromRecord(
  implicitLabel: string,
  effectRecordType: SourceNamespaceType,
  pathPrefix: string[],
  result: EvidenceParameter[]
): void {
  for (const field of effectRecordType.fields) {
    if (isFunctionType(field.type)) {
      // Forall function fields are passed as void* and cast at each call site
      const fieldPath = [...pathPrefix, field.label];
      const fieldLabel = fieldPath.join("__");
      result.push({
        implicitLabel,
        fieldLabel,
        fieldPath,
        fieldFunctionType: field.type,
        cParamName: sanitizeForCIdentifier(`${implicitLabel}__${fieldLabel}`),
      });
    } else if (isSourceNamespaceType(field.type) || isStructType(field.type)) {
      collectEvidenceFromRecord(
        implicitLabel,
        field.type as SourceNamespaceType,
        [...pathPrefix, field.label],
        result
      );
    }
  }
}

/**
 * Generate function prototype
/**
 * Expand effect row spreads in implicit parameters into individual parameters.
 */
function expandImplicitParameters(
  implicits: FunctionParameter[]
): FunctionParameter[] {
  return implicits.slice();
}

/**
 * Generate function prototype
 */
export function generateFunctionPrototype(
  functionType: FunctionType,
  cFunctionName: string,
  context: CodeGenContext,
  overrideReturnType?: string,
  originalFunctionType?: FunctionType
): string {
  // For non-main functions, generate based on function type.
  // `-> ref(T)` lowers to a `T*` return at the C ABI — the function
  // yields a second-class reference whose storage is rooted in one
  // of its `ref`-typed parameters. See `plans/archive/ITERATOR_REDESIGN.md`.
  let returnTypeStr: string;
  if (overrideReturnType) {
    returnTypeStr = overrideReturnType;
  } else {
    const baseReturnType = getTypeString(functionType.return.type, context);
    returnTypeStr = functionType.return.isRef
      ? `${baseReturnType}*`
      : baseReturnType;
  }

  // Generate parameter list (excluding compile-time parameters)
  const runtimeParams = functionType.parameters.filter(
    (param) => !param.isCompileTimeOnly
  );
  const paramStrings: string[] = [];

  // For closure functions, add a generic closure context as the first parameter
  // The function body will cast this to the correct capture struct type
  if (functionType.isClosure) {
    paramStrings.push(`void* closure_context`);
  }

  // Add regular parameters
  const regularParamStrings = runtimeParams.map((param, index) => {
    const paramName = sanitizeForCIdentifier(param.label || `param${index}`);

    // Handle function pointer parameters specially
    if (isFunctionType(param.type)) {
      const functionPointerType = generateFunctionPrototype(
        param.type,
        "(*)",
        context
      ).replace(" (*)(", ` (*${paramName})(`);

      return functionPointerType;
    } else {
      // Handle non-function parameters
      let paramTypeStr: string;
      if (isSomeType(param.type) && typeImplementsFuture(param.type)) {
        // For Future types, use the resolved concrete type (state machine) if available,
        // otherwise fall back to getTypeString which has multiple lookup paths
        // (SomeType ID → registered async struct, resolvedConcreteType, etc.)
        if (param.type.resolvedConcreteType) {
          // Use the concrete state machine pointer type
          paramTypeStr =
            getTypeString(param.type.resolvedConcreteType, context) + "*";
        } else {
          // The SomeType ID may be registered by preRegisterAsyncTypes
          // (e.g., when the parameter type comes from an io.async call at the call site)
          paramTypeStr = getTypeString(param.type, context);
        }
      } else {
        paramTypeStr = getTypeString(param.type, context);
      }

      // inout(name) : T lowers to T* in C. Reads of `name` in the
      // body become `(*name)`; writes become `(*name) = v`. The
      // identifier `name` itself never escapes the callee. See
      // plans/MEMORY_SAFETY.md Phase B.
      if (param.isRef) {
        paramTypeStr = `${paramTypeStr}*`;
      }

      return `${paramTypeStr} ${paramName}`;
    }
  });

  paramStrings.push(...regularParamStrings);

  // Add evidence parameters for record-typed implicit params (evidence passing).
  // Each function-typed field of a record-typed using() param becomes an extra
  // C function pointer parameter.
  //
  // NOTE: specializedType typically has empty implicitParameters (resolved during
  // specialization). We use originalFunctionType (the pre-specialization type)
  // to detect record-typed implicit params.
  const evidenceParams = getEvidenceParameters(
    originalFunctionType ?? functionType
  );
  for (const ep of evidenceParams) {
    // For generic function types, use void* — the body casts to the right type at each call site.
    if (
      ep.fieldFunctionType.forallParameters &&
      ep.fieldFunctionType.forallParameters.length > 0
    ) {
      paramStrings.push(`void* ${ep.cParamName}`);
    } else {
      // Generate the fn ptr parameter: returnType (*name)(paramTypes...)
      const fnPtrProto = generateFunctionPrototype(
        ep.fieldFunctionType,
        "(*)",
        context
      ).replace(" (*)(", ` (*${ep.cParamName})(`);
      paramStrings.push(fnPtrProto);
    }
  }

  const params = paramStrings.join(", ");
  return `${returnTypeStr} ${cFunctionName}(${params})`;
}

/**
 * Generate a function declaration (prototype)
 */
export function generateFunctionDeclaration(
  functionType: FunctionType,
  cFunctionName: string,
  isExtern: boolean,
  context: CodeGenContext,
  functionBody?: Expr,
  originalFunctionType?: FunctionType
): void {
  // For functions returning Impl(Future(T)), find the async block that produces the return value
  // and use its state machine struct name as the return type
  let overrideReturnType: string | undefined;

  if (functionBody && typeImplementsFuture(functionType.return.type)) {
    const asyncBlock = findReturnedAsyncBlock(functionBody);
    if (asyncBlock?.$?.asyncStateMachineStructName) {
      overrideReturnType = `${asyncBlock.$.asyncStateMachineStructName}*`;
    } else if (
      functionBody.$?.type &&
      isSomeType(functionBody.$.type) &&
      typeImplementsFuture(functionBody.$.type)
    ) {
      // Function delegates to another function returning Impl(Future(T))
      // (e.g., File.open calls File.open_with which contains the io.async block).
      // The body's type SomeType may have resolvedConcreteType pointing to the
      // async block's SomeType, which is registered in context.types.
      overrideReturnType = getTypeString(functionBody.$.type, context);
    }
  }

  // For functions returning plain Impl(...) (SomeType), use the concrete type from the body
  // This is for static dispatch - the body's actual return type is the function's return type
  if (
    functionBody &&
    isSomeType(functionType.return.type) &&
    !typeImplementsFuture(functionType.return.type)
  ) {
    // The body should have the concrete return type
    if (functionBody.$?.type) {
      overrideReturnType = getTypeString(functionBody.$.type, context);
    }
  }

  // For specialized functions where the body's return type is more specific than the signature's
  // (e.g., when generic type parameters have been substituted but the signature still uses generic types)
  // Use the body's concrete return type.
  //
  // IMPORTANT: Only apply this override when the signature return type is generic (SomeType).
  // If the signature is concrete (e.g., `unit` → `void`), the body type may have been
  // mutated by effect escape analysis and should NOT override the declared signature type.
  // Applying the override for concrete types causes "conflicting types" C errors when the
  // same function is called with an escaping handler (body gets annotated with the escape
  // type, but the forward declaration must match the signature, not the escape type).
  if (
    !overrideReturnType &&
    functionBody &&
    functionBody.$?.type &&
    !typeImplementsFuture(functionType.return.type) &&
    (isSomeType(functionType.return.type) ||
      typeContainsSomeType(functionType.return.type))
  ) {
    const signatureReturnTypeCName = getTypeString(
      functionType.return.type,
      context
    );
    const bodyReturnTypeCName = getTypeString(functionBody.$.type, context);
    if (signatureReturnTypeCName !== bodyReturnTypeCName) {
      overrideReturnType = bodyReturnTypeCName;
    }
  }

  const functionPrototype = overrideReturnType
    ? generateFunctionPrototype(
        functionType,
        cFunctionName,
        context,
        overrideReturnType,
        originalFunctionType
      )
    : generateFunctionPrototype(
        functionType,
        cFunctionName,
        context,
        undefined,
        originalFunctionType
      );

  const yoTypeStr = typeToString(functionType);
  // Non-extern functions are 'static' (internal linkage) since all Yo code
  // compiles to a single C file. This enables the C compiler to strip unused
  // functions with -O2.
  // Exported functions and __yo_user_main keep external linkage.
  // RC functions (___drop, ___dup) get __attribute__((always_inline)) to ensure
  // the C compiler inlines them even at -Os, avoiding unnecessary struct copies
  // in tight loops like ArrayList._free_elements.
  const isExportedByName =
    cFunctionName === "__yo_user_main" ||
    (context.exportedFunctionLabels &&
      [...context.exportedFunctionLabels.values()].some(
        (label) => sanitizeForCIdentifier(label) === cFunctionName
      ));
  const isRcFunction =
    !isExtern &&
    !isExportedByName &&
    (cFunctionName.includes("___drop") ||
      cFunctionName.includes("___dup") ||
      cFunctionName.includes("___dispose"));
  const linkagePrefix = isExtern
    ? "extern "
    : isExportedByName
      ? ""
      : isRcFunction
        ? "static inline __attribute__((always_inline)) "
        : "static inline ";
  context.emitter.emitDeclarationLine(
    `${linkagePrefix}${functionPrototype}; // ${yoTypeStr}`
  );
}

/**
 * Generate constructor function declarations for objects
 */
export function generateObjectConstructorDeclarations(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate builtin reference counting functions (static — single C file)
  emitter.emitDeclarationLine(
    `static inline void __yo_decr_rc(void* ptr); // Decrement reference count`
  );
  emitter.emitDeclarationLine(
    `static inline void* __yo_incr_rc(void* ptr); // Increment reference count`
  );

  // Generate GC function declarations
  emitter.emitDeclarationLine(
    `static void __yo_gc_register(void* ptr); // Register object for cycle detection`
  );
  emitter.emitDeclarationLine(
    `static void __yo_gc_unregister(void* ptr); // Unregister object from cycle detection`
  );
  emitter.emitDeclarationLine(
    `static void __yo_gc_collect(); // Thorough full-heap cycle collection (explicit Gc.collect())`
  );
  emitter.emitDeclarationLine(
    `static void __yo_gc_collect_incremental(); // Bacon-Rajan incremental collection (auto-trigger)`
  );
  emitter.emitDeclarationLine(
    `static void __yo_gc_add_root(void* ptr); // Bacon-Rajan: buffer a possible cycle root`
  );
  emitter.emitDeclarationLine(
    `static void __yo_gc_remove_root(void* ptr); // Bacon-Rajan: unbuffer a possible cycle root`
  );
  emitter.emitDeclarationLine(
    `static void __yo_gc_init_thread(); // Initialize thread-local GC state (for worker threads)`
  );
  emitter.emitDeclarationLine(
    `static void __yo_cleanup_thread_gc(); // Clean up thread-local GC state`
  );
  emitter.emitDeclarationLine(
    `static void __yo_init_process_cleanup(void); // Initialize process cleanup`
  );

  // Generate constructor declarations for each object
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (isStructType(type) && type.isReferenceSemantics) {
      // Skip generic structs that contain SomeType parameters
      const hasGenericTypes = type.fields.some((field) =>
        typeContainsSomeType(field.type)
      );

      if (hasGenericTypes) {
        continue; // Skip generic structs - only generate constructors for concrete types
      }

      // Generate constructor function declaration
      const constructorName = `__yo_new_${cName}`;
      const paramTypes = type.fields
        .map((field) => {
          const fieldType = getTypeString(field.type, context);
          const fieldName = sanitizeForCIdentifier(field.label);
          return `${fieldType} ${fieldName}`;
        })
        .join(", ");

      emitter.emitDeclarationLine(
        `static ${cName}* ${constructorName}(${paramTypes}); // Constructor`
      );
    }
  }

  // Per-variant constructor declarations for reference-semantics enums
  // (`ref(enum(…))`). plans/REF_REFERENCE_SEMANTICS.md Phase 3.
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (isEnumType(type) && type.isReferenceSemantics) {
      if (typeContainsSomeType(type)) {
        continue;
      }
      for (const variant of type.variants) {
        const nonUnitFields = (variant.fields ?? []).filter(
          (field) => !isUnitType(field.type)
        );
        const paramTypes = nonUnitFields
          .map((field) => {
            const fieldType = getTypeString(field.type, context);
            const fieldName = sanitizeForCIdentifier(field.label);
            return `${fieldType} ${fieldName}`;
          })
          .join(", ");
        emitter.emitDeclarationLine(
          `static ${cName}* __yo_new_${cName}_${variant.name}(${paramTypes}); // Constructor`
        );
      }
    }
  }
}

export function generateClosureConstructorDeclarations(
  context: FunctionGenerationContext
): void {
  // No-op: Impl(Fn(...)) closures use concrete capture structs + direct calls.
  // Dyn(Fn(...)) uses dyn constructors (generated elsewhere).
  void context;
}

/**
 * Generate declarations for capture-specific dispose functions
 */
export function generateCaptureDisposeFunctionDeclarations(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate forward declarations for closure dispose functions
  // These are generated from closureCaptureMap which is populated during closure creation
  if (context.closureCaptureMap && context.closureCaptureMap.size > 0) {
    for (const [closureInstanceId] of context.closureCaptureMap) {
      const disposeFunctionName = `__yo_dispose_closure_${closureInstanceId}`;
      emitter.emitDeclarationLine(
        `static void ${disposeFunctionName}(void* closure_ptr);`
      );
    }
  }
}

/**
 * Generate vtable instance declarations for closures
 */
export function generateClosureVtableDeclarations(
  _context: FunctionGenerationContext
): void {
  // No static vtable instances - closures will create vtables dynamically
  // Each closure instance will have its own vtable with appropriate drop function
}

/**
 * Generate declarations for specialized (monomorphized) functions
 */
export function generateSpecializedFunctionDeclarations(
  context: CodeGenContext
): void {
  const generated = new Set<FuncValueId>(); // Track already generated declarations
  for (const funcId in context.functions) {
    const { value: functionValue, cName: cFunctionName } =
      context.functions[funcId]!;
    const specializedFunctionType = functionValue.specializedType;

    if (isComptimeFunction(functionValue)) {
      // Skip compile-time only functions
      continue;
    }

    if (
      !specializedFunctionType ||
      !isFunctionTypeGeneric(functionValue.type)
    ) {
      continue; // Skip non-generic functions
    }

    // Skip if the specialized type still has unresolved type parameters.
    // Use the same "isUnresolvedSomeType" logic as generateSpecializedFunctions:
    // Fn and Future SomeTypes are treated as concrete at codegen time (void*
    // and state-machine struct respectively), so they must NOT be counted as
    // unresolved. This ensures forward declarations are emitted for functions
    // like `walk_expr_` whose `get_info : Impl(Fn(...))` param is void* in C.
    const isUnresolvedSomeTypeForDecl = (t: Type): boolean => {
      if (!isSomeType(t)) return false;
      if ((t as SomeType).resolvedConcreteType) return false;
      if (typeImplementsFuture(t)) return false;
      if (typeImplementsFn(t)) return false;
      return true;
    };
    const hasForallOrCompileTimeSpecDecl =
      specializedFunctionType.forallParameters.length > 0 ||
      specializedFunctionType.parameters.some((p) => p.isCompileTimeOnly);
    const hasSomeTypeParamsSpecDecl = specializedFunctionType.parameters.some(
      (p) => !p.isCompileTimeOnly && isUnresolvedSomeTypeForDecl(p.type)
    );
    if (hasForallOrCompileTimeSpecDecl || hasSomeTypeParamsSpecDecl) {
      continue;
    }

    // Also skip if any parameter type contains SomeType (generic type parameters)
    // This happens when a function specialization wasn't completed properly
    const hasGenericParams = specializedFunctionType.parameters.some((p) =>
      typeContainsSomeType(p.type)
    );
    const hasGenericReturnType = typeContainsSomeType(
      specializedFunctionType.return.type
    );
    if (hasGenericParams || hasGenericReturnType) {
      continue;
    }

    // Skip if the original function type has evidence parameters — the regular
    // forward declaration loop already emits a correct declaration with evidence
    // params included (via originalFunctionType fallback).
    // Only skip for generic evidence params (which need void* evidence passing).
    // Non-generic using params that were resolved during specialization should still
    // have their specialized declarations emitted.
    const origEvidenceParams = getEvidenceParameters(functionValue.type);
    if (
      origEvidenceParams.some(
        (ep) =>
          ep.fieldFunctionType.forallParameters &&
          ep.fieldFunctionType.forallParameters.length > 0
      )
    ) {
      continue;
    }

    // Skip if already generated
    if (generated.has(funcId)) {
      continue;
    }
    generated.add(funcId);

    // Emit the function declaration
    // RC functions get __attribute__((always_inline)) for better optimization at -Os
    const specializedIsRcFunction =
      cFunctionName.includes("___drop") ||
      cFunctionName.includes("___dup") ||
      cFunctionName.includes("___dispose");
    const specializedPrefix = specializedIsRcFunction
      ? "static inline __attribute__((always_inline)) "
      : "static inline ";
    context.emitter.emitDeclarationLine(
      `${specializedPrefix}${generateFunctionPrototype(specializedFunctionType, cFunctionName, context)}; // specialized function: ${typeToString(functionValue.type)}`
    );
  }
}
