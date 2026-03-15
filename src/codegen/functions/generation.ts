import { type Environment } from "../../env";
import { isIoAsyncCall } from "../../evaluator/async/await-analysis";
import { typeImplementsFuture } from "../../evaluator/trait-checking";
import { findMatchingGenericImpl } from "../../evaluator/values/impl";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  type Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  hasAnyControlFlow,
} from "../../expr";
import { type FunctionValue } from "../../function-value";
import { areTypesCompatible } from "../../types/compatibility";
import type {
  EnumType,
  FunctionType,
  TraitType,
  Type,
} from "../../types/definitions";
import { getTraitTypeFromEnv } from "../../types/env-lookup";
import {
  isEnumType,
  isFunctionType,
  isFunctionTypeGeneric,
  isFunctionTypeHardGeneric,
  isSomeType,
  isStructType,
  isUnitType,
} from "../../types/guards";
import {
  canTypeFormRcCycle,
  typeContainsSomeType,
  typeToString,
} from "../../types/utils";
import { isTempVariableName } from "../../utils";
import { isFunctionValue, isTraitValue, type TraitValue } from "../../value";
import { generateAsyncRuntime } from "../async/runtime";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
} from "../exprs/drop-dup";
import { generateExpr } from "../exprs/expr";
import { generateImplicitReturnStatement } from "../exprs/return";
import { generateParallelismRuntime } from "../parallelism/runtime";
import { generateIsoTypeDeclarations } from "../types/generation";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  type CodeGenContext,
  findReturnedAsyncBlock,
  getTypeString,
  getVariableNameForCodegen,
  isComptimeFunction,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
  sanitizeForCIdentifier,
} from "../utils";
import type { FunctionGenerationContext } from "./context";
import {
  type EvidenceParameter,
  generateFunctionPrototype,
  getEvidenceParameters,
} from "./declarations";

/**
 * Find the Dispose trait value attached to a type, if any.
 * Uses trait identity (not just method name) to match Dispose.
 * Also checks generic impl registry for forall impls like:
 *   impl(forall(T : Type), ArrayList(T), Dispose(...))
 */
function findDisposeTraitValue(
  type: Type,
  env: Environment
): TraitValue | undefined {
  const disposeTraitType = getTraitTypeFromEnv(env, "Dispose");
  if (!disposeTraitType) {
    return undefined;
  }

  const expectedTraitWithReceiver: TraitType = {
    ...disposeTraitType,
    receiverType: type,
  };

  // First check if Dispose trait is directly attached to the type
  if (type.trait) {
    for (const field of type.trait.fields) {
      if (!field.assignedValue || !isTraitValue(field.assignedValue)) {
        continue;
      }

      const fieldTraitValue = field.assignedValue;
      const fieldTraitType = fieldTraitValue.type;

      if (
        areTypesCompatible(
          { type: expectedTraitWithReceiver, env },
          { type: fieldTraitType, env }
        )
      ) {
        return fieldTraitValue;
      }
    }
  }

  // Fallback: check generic impl registry for forall impls
  const genericImpl = findMatchingGenericImpl({
    concreteType: type,
    traitType: disposeTraitType,
    env,
  });
  if (genericImpl) {
    return genericImpl.traitValue;
  }

  return undefined;
}

/**
 * Find the user's dispose method from the Dispose trait.
 * Returns the C function name if found, undefined otherwise.
 */
function findUserDisposeMethodForType(
  type: Type,
  env: Environment,
  context: CodeGenContext
): string | undefined {
  const traitValue = findDisposeTraitValue(type, env);
  if (!traitValue) {
    return undefined;
  }

  const disposeIndex = traitValue.type.fields.findIndex(
    (field) => field.label === BuiltinFunctions.dispose[0]
  );
  if (disposeIndex < 0) {
    return undefined;
  }

  const disposeValue = traitValue.fields[disposeIndex];
  if (!isFunctionValue(disposeValue)) {
    return undefined;
  }

  // First try direct lookup by funcId
  const directLookup = context.functions[disposeValue.funcId]?.cName;
  if (directLookup) {
    return directLookup;
  }

  // For generic impls, the dispose function is generic and needs specialization.
  // Search for a specialized version of dispose for this SelfType.
  // Look for functions with funcName === "dispose" and matching SelfType.
  for (const funcId in context.functions) {
    const funcEntry = context.functions[funcId]!;
    const funcValue = funcEntry.value;
    const funcType = funcValue.specializedType ?? funcValue.type;

    if (funcValue.funcName !== BuiltinFunctions.dispose[0]) {
      continue;
    }

    // Check if SelfType matches
    if (
      funcType.SelfType &&
      areTypesCompatible({ type: funcType.SelfType, env }, { type, env })
    ) {
      return funcEntry.cName;
    }
  }

  return undefined;
}

/**
 * Generate all collected functions
 */
export function generateAllFunctions(context: FunctionGenerationContext): void {
  context.emitter.emitLine(`// Function implementations`);

  // Generate async/await runtime first (defines yo_continuation_t used by worker threads)
  generateAsyncRuntime(context.emitter, context.debugAsyncAwait);

  // Generate parallelism runtime (Worker, Channel for multi-threaded execution)
  generateParallelismRuntime(context.emitter, context.debugParallelism);

  // Generate thread-safe GC runtime functions
  generateAtomicGCRuntimeFunctions(context);

  // Generate object constructor functions
  generateRefStructConstructorFunctions(context);

  // Generate closure constructor and Rc functions
  generateClosureConstructorFunctions(context);

  // NOTE: Don't generate capture dispose functions here yet!
  // They will be generated after deferred async blocks are processed
  // because closure creation happens during async block generation

  for (const funcId in context.functions) {
    const { value, cName } = context.functions[funcId]!;

    // Never skip __yo_user_main - it's the entry point and its implicit
    // IO parameter is resolved at compile time
    const isUserMain = cName === "__yo_user_main";

    // Check if this function's body has effect analysis (it uses algebraic effects).
    // If so, its function-typed implicit parameters are effect handlers that are resolved
    // by the effect system at the call site — they are NOT truly unresolved.
    const bodyEffectAnalysis = value.body?.$?.effectAnalysis;
    const isEffectfulFunction =
      bodyEffectAnalysis && bodyEffectAnalysis.hasEffects;

    // Skip the original (unspecialized) function when it has specialization caches.
    // The specialized versions are separate entries in context.functions and will
    // be generated instead. The original's body was evaluated generically and
    // sub-expressions may lack type annotations, making codegen impossible.
    // This applies even when the function was marked effectful — the effectful
    // generation needs properly annotated sub-expressions too.
    if (
      !isUserMain &&
      !value.type.isClosure &&
      value.specializedFunctionCaches?.length > 0
    ) {
      continue;
    }

    const hasUnresolvedFunctionImplicitParams =
      !isUserMain &&
      !isEffectfulFunction &&
      !value.isModuleEffectMember &&
      !value.type.isClosure &&
      !value.specializedType &&
      (value.specializedFunctionCaches?.length ?? 0) === 0 &&
      getEvidenceParameters(value.specializedType ?? value.type).length === 0 &&
      [
        ...value.type.implicitParameters,
        ...value.type.parameters.filter((p) => p.isImplicit),
      ].some((param) => isFunctionType(param.type));

    if (hasUnresolvedFunctionImplicitParams) {
      continue;
    }

    // If the function is generic or has been specialized, we will handle it later
    // EXCEPTION: Specialized functions from impl methods (not generic at function level)
    // should be generated here, not in generateSpecializedFunctions
    const isSpecializedImplMethod =
      value.specializedType && !isFunctionTypeGeneric(value.type);

    // Check if the function has evidence params (from resolved spread implicits)
    // Functions with evidence params need standalone bodies even if the body
    // doesn't appear effectful (effects were resolved during specialization)
    const functionTypeForCheck = value.specializedType ?? value.type;
    const hasEvidenceParams =
      getEvidenceParameters(functionTypeForCheck).length > 0;

    // Skip hard-generic or comptime-return functions with no specialization.
    // These exist only as compile-time templates — their unspecialized
    // bodies reference comptime bindings not available at runtime.
    // Exception: effect handler functions (isModuleEffectMember) must be
    // generated even when hard-generic — their forall params are erased
    // at runtime and they're stored as void* function pointers.
    if (
      !isUserMain &&
      !value.isModuleEffectMember &&
      !value.specializedType &&
      (value.specializedFunctionCaches?.length ?? 0) === 0 &&
      (isFunctionTypeHardGeneric(value.type) || isComptimeFunction(value))
    ) {
      continue;
    }

    // IO async state machine closures are always generated via the deferred
    // async block system, never as standalone functions. Skip unconditionally
    // to prevent duplicate struct/function definitions.
    if (!isUserMain && value.isIoAsyncStateMachineClosure) {
      continue;
    }

    if (
      !isUserMain &&
      !isEffectfulFunction &&
      !hasEvidenceParams &&
      !value.isModuleEffectMember &&
      ((isFunctionTypeHardGeneric(value.type) && !value.type.isClosure) ||
        (value.specializedFunctionCaches?.length > 0 &&
          !value.type.isClosure) ||
        (value.specializedType && !isSpecializedImplMethod) ||
        isComptimeFunction(value) ||
        isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(value) ||
        value.isIoAsyncStateMachineClosure)
    ) {
      continue;
    }

    // Skip functions with SomeType in parameters (truly generic)
    // Or with SomeType in return type that isn't an Impl(Module) or Impl(Future)
    // Use specializedType if available, otherwise use type
    const functionType = value.specializedType ?? value.type;
    const hasGenericParams =
      !isEffectfulFunction &&
      !value.isModuleEffectMember &&
      (functionType.parameters.some((p) => typeContainsSomeType(p.type)) ||
        functionType.forallParameters.length > 0);
    const hasGenericReturnType = typeContainsSomeType(functionType.return.type);

    // Allow functions returning plain Impl(Module) existential types (SomeType at top level)
    // These are not truly generic - the concrete type is determined from the function body
    const returnsPlainImpl =
      isSomeType(functionType.return.type) &&
      functionType.return.type.requiredTraits.length > 0;

    if (
      hasGenericParams ||
      (hasGenericReturnType && !returnsPlainImpl && !value.isModuleEffectMember)
    ) {
      continue;
    }

    // Check if this is an effectful function (body has effect call points)
    const effectAnalysis = value.body?.$?.effectAnalysis;
    if (effectAnalysis && effectAnalysis.hasEffects) {
      // All effects use evidence passing (fn ptr params).
      // Fall through to normal function generation.
    }

    // Generate the function body
    generateFunction(value, cName, context);
  }

  // Generate Iso type declarations if any were collected during expression generation
  generateIsoTypeDeclarations(context);

  // NOTE: Main wrapper is generated after deferred async blocks
  // since async main returns a Future type that's defined in the deferred blocks
}

/**
 * Generate a main() wrapper that calls __yo_user_main() and then __yo_async_wait_all()
 * This ensures all async tasks complete before the program exits
 * REQUIREMENT: main function must return unit (void)
 */
export function generateMainWrapper(context: FunctionGenerationContext): void {
  const emitter = context.emitter;

  // Check if user defined a main function
  let hasMain = false;
  let mainFunctionValue: FunctionValue | null = null;
  for (const funcId in context.functions) {
    const { cName, value } = context.functions[funcId]!;
    if (cName === "__yo_user_main") {
      hasMain = true;
      mainFunctionValue = value;
      break;
    }
  }

  if (!hasMain || !mainFunctionValue) {
    return; // No main function, nothing to wrap
  }

  // REQUIREMENT: main must return unit or Impl(Future(unit))
  const returnType = mainFunctionValue.type.return.type;
  const returnsUnit = isUnitType(returnType);

  if (!returnsUnit) {
    throw new Error(
      `main function must return unit , but it returns ${typeToString(returnType)}. ` +
        `Use 'main :: (fn() -> unit)' instead. ` +
        `For exit codes, use 'exit(code)' from std/libc/stdlib.yo`
    );
  }

  {
    // Get evidence parameters for main function (e.g., IO module fields)
    const evidenceParams = getEvidenceParameters(mainFunctionValue.type);
    const evidenceArgs = evidenceParams.map(() => "NULL").join(", ");
    const mainCallArgs = evidenceArgs ? `(${evidenceArgs})` : "()";

    // Sync main - call it directly and wait for any async tasks
    emitter.emitLine(`
// Main wrapper - calls __yo_user_main directly
int main(int argc, char** argv) {
  // Store command-line arguments
  __yo_argc = (int32_t)argc;
  __yo_argv = (uint8_t**)argv;
  __yo_args = (Slice_uint8_t_u42_){ .data = (uint8_t**)argv, .length = (size_t)argc };
  
  // Initialize async runtime (in case async blocks are used)
  __yo_async_scheduler_init();
  
  // Call sync main
  __yo_user_main${mainCallArgs};
  
  // Wait for all async tasks to complete
  // This ensures any async blocks spawned in main finish before exit
  __yo_async_wait_all();
  
  return 0;
}
`);
  }
}

/**
 * Pre-register all effectful functions across both regular and specialized function sets.
 * This must run BEFORE any function bodies are generated, so that call sites can find
 * the effectStateMachineInfo when generating calls to effectful functions.
 *
 * This pass:
 * 1. Scans all functions for effect analysis
 * 2. Creates SM info and stores it on funcEntries
 * 3. Generates SM struct definitions and forward declarations
 * 4. Defers resume function body generation
 */
export function preRegisterEffectfulFunctions(
  context: FunctionGenerationContext
): void {
  for (const funcId in context.functions) {
    const { value: functionValue } = context.functions[funcId]!;

    if (isComptimeFunction(functionValue)) {
      continue;
    }

    // Check if this function has effect analysis
    const effectAnalysis = functionValue.body?.$?.effectAnalysis;
    if (!effectAnalysis || !effectAnalysis.hasEffects) {
      continue;
    }

    // Skip if the specialized type still has unresolved type parameters
    if (functionValue.specializedType) {
      // Don't use isFunctionTypeGeneric here — it treats implicitParameters as generic,
      // but resolved implicit params (from spread evidence) are NOT generic.
      // Instead, check only for actual generic indicators:
      const st = functionValue.specializedType;
      const hasForallOrCompileTime =
        st.forallParameters.length > 0 ||
        st.parameters.some((p) => p.isCompileTimeOnly);
      const hasSomeTypeParams = st.parameters.some(
        (p) =>
          !p.isCompileTimeOnly &&
          isSomeType(p.type) &&
          !typeImplementsFuture(p.type)
      );
      if (hasForallOrCompileTime || hasSomeTypeParams) {
        continue;
      }
      const hasGenericParams = functionValue.specializedType.parameters.some(
        (p) => typeContainsSomeType(p.type)
      );
      const hasGenericReturnType = typeContainsSomeType(
        functionValue.specializedType.return.type
      );
      if (hasGenericParams || hasGenericReturnType) {
        continue;
      }
    }

    // Check if this function has evidence parameters. If so, it will use
    // evidence passing (fn ptr params) instead of SM-inlining.
    // Try the specialized type first (has expanded effect row spreads),
    // then fall back to the original type (retains implicit parameters
    // that specialization may strip for forall effects only).
    let evidenceParams = getEvidenceParameters(
      functionValue.specializedType ?? functionValue.type
    );
    if (evidenceParams.length === 0 && functionValue.specializedType) {
      const fallbackParams = getEvidenceParameters(functionValue.type);
      if (
        fallbackParams.some(
          (ep) =>
            ep.fieldFunctionType.forallParameters &&
            ep.fieldFunctionType.forallParameters.length > 0
        )
      ) {
        evidenceParams = fallbackParams;
      }
    }

    // Use evidence passing when evidence params are available.
    // Functions with evidence params receive their effects as fn ptr parameters.
    // Direct effect calls in the body compile as fn ptr calls through those params,
    // with escape checking after each call. No SM needed.
    const canUseEvidence = evidenceParams.length > 0;
    if (canUseEvidence) {
      // Skip SM registration — this function will use evidence passing
      continue;
    }

    // No evidence params — this shouldn't happen for current effect patterns.
    // All effects (including forall) use evidence passing.
  }
}

/**
 * Generate C code for a function
 */
export function generateFunction(
  functionValue: FunctionValue,
  cFunctionName: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Use provided C function name or default to label
  const functionName = cFunctionName;
  const functionType = functionValue.specializedType ?? functionValue.type;

  // For functions returning Impl(Future(T)), find the async block that produces the return value
  // and use its state machine struct name as the return type
  let overrideReturnType: string | undefined;

  if (functionValue.body && typeImplementsFuture(functionType.return.type)) {
    const asyncBlock = findReturnedAsyncBlock(functionValue.body);
    if (asyncBlock?.$?.asyncStateMachineStructName) {
      overrideReturnType = `${asyncBlock.$.asyncStateMachineStructName}*`;
    } else if (
      functionValue.body.$?.type &&
      isSomeType(functionValue.body.$.type) &&
      typeImplementsFuture(functionValue.body.$.type)
    ) {
      // Function delegates to another function returning Impl(Future(T))
      // (e.g., File.open calls File.open_with which contains the io.async block).
      // The body's type SomeType may have resolvedConcreteType pointing to the
      // async block's SomeType, which is registered in context.types.
      overrideReturnType = getTypeString(functionValue.body.$.type, context);
    }
  }

  // For functions returning Impl(Module) (SomeType), use the concrete type from the body
  // This is for static dispatch - the body's actual return type is the function's return type
  // BUT: Don't do this for specialized functions - their specializedType is already correct
  if (
    functionValue.body &&
    isSomeType(functionType.return.type) &&
    !typeImplementsFuture(functionType.return.type) &&
    !functionValue.specializedType && // Don't override for specialized functions
    !functionValue.isModuleEffectMember // Module effect handlers use SomeType → void consistently
  ) {
    // The body should have the concrete return type
    if (functionValue.body.$?.type) {
      overrideReturnType = getTypeString(functionValue.body.$.type, context);
    }
  }

  // For specialized functions where the body's return type is more specific than the signature's
  // (e.g., when generic type parameters have been substituted but the signature still uses generic types)
  // Use the body's concrete return type
  // SKIP THIS: The body type might not be properly updated during specialization
  // The specializedType is already correct, so just use it
  /*
  if (
    !overrideReturnType &&
    functionValue.body &&
    functionValue.body.$?.type &&
    functionValue.specializedType
  ) {
    const signatureReturnTypeCName = getTypeString(
      functionType.return.type,
      context
    );
    const bodyReturnTypeCName = getTypeString(
      functionValue.body.$.type,
      context
    );
    if (signatureReturnTypeCName !== bodyReturnTypeCName) {
      overrideReturnType = bodyReturnTypeCName;
    }
  }
  */

  // Regular function generation (async blocks within the function handle their own state machines)
  // After specialization, specializedType includes resolved implicit parameters,
  // so we can use functionType directly (which is specializedType ?? type).
  // Pass the original (pre-specialization) type so evidence params are detected
  // even when specialization strips implicit parameters.
  // Pass original type so evidence params are detected when specialization
  // strips implicit parameters (e.g., for forall effects).
  // Only do this when specializedType has no evidence but the original does,
  // AND the original has forall function evidence params (which need void* passing).
  // Non-forall using params are resolved at specialization time and don't need this.
  const originalFunctionType =
    functionValue.specializedType &&
    getEvidenceParameters(functionType).length === 0 &&
    getEvidenceParameters(functionValue.type).some(
      (ep) =>
        ep.fieldFunctionType.forallParameters &&
        ep.fieldFunctionType.forallParameters.length > 0
    )
      ? functionValue.type
      : undefined;
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

  emitter.emitLine(`${functionPrototype} {`);

  // Set current function name and type for recur support and async handling
  const previousFunctionName = context.currentFunctionName;
  const previousFunctionType = (context as FunctionGenerationContext)
    .currentFunctionType;
  context.currentFunctionName = functionName;
  (context as FunctionGenerationContext).currentFunctionType = functionType;

  // Track if this is a module effect member function (for escape detection)
  const previousIsModuleEffectMemberFunction = (
    context as FunctionGenerationContext
  ).isModuleEffectMemberFunction;
  const previousOverrideReturnTypeStr = (context as FunctionGenerationContext)
    .overrideReturnTypeStr;
  if (functionValue.isModuleEffectMember) {
    (context as FunctionGenerationContext).isModuleEffectMemberFunction = true;
  }
  // Store override return type for escape codegen (when the C return type
  // differs from the SomeType-based return type in the function signature)
  (context as FunctionGenerationContext).overrideReturnTypeStr =
    overrideReturnType;

  // Set up evidence parameters for module-based effect functions.
  // This maps module field accesses (e.g., raise_mod.raise) to the evidence
  // fn ptr parameter names so body codegen can resolve them.
  // Try the specialized type first (has expanded effect row spreads),
  // then fall back to the original type (retains implicit parameters
  // that specialization may strip for forall effects).
  const previousEvidenceParams = (context as FunctionGenerationContext)
    .currentEvidenceParams;
  let evidenceParams = getEvidenceParameters(functionType);
  if (evidenceParams.length === 0 && functionValue.specializedType) {
    const fallbackParams = getEvidenceParameters(functionValue.type);
    if (
      fallbackParams.some(
        (ep) =>
          ep.fieldFunctionType.forallParameters &&
          ep.fieldFunctionType.forallParameters.length > 0
      )
    ) {
      evidenceParams = fallbackParams;
    }
  }
  if (evidenceParams.length > 0) {
    const evidenceMap = new Map<string, EvidenceParameter>();
    for (const ep of evidenceParams) {
      evidenceMap.set(`${ep.implicitLabel}.${ep.fieldLabel}`, ep);
    }
    (context as FunctionGenerationContext).currentEvidenceParams = evidenceMap;
  }

  // Set closure capture context if this is a closure function
  const previousClosureCaptures = context.currentClosureCaptures;
  const previousClosureCaptureFrameLevel =
    context.currentClosureCaptureFrameLevel;
  const previousClosureType = (context as FunctionGenerationContext)
    .currentClosureType;
  const previousClosureCaptureTypeCName = (context as FunctionGenerationContext)
    .currentClosureCaptureTypeCName;

  if (functionType.isClosure) {
    // Use the closure info stored on the function value (set during evaluation)
    const closureInfo = functionValue.closureInfo;

    if (closureInfo) {
      const closureType = closureInfo.closureType.isFn;
      const captureType = closureInfo.captureType;

      (context as FunctionGenerationContext).currentClosureType =
        closureType.callType;

      // Get captured variables from the capture type
      if (
        captureType &&
        isStructType(captureType) &&
        captureType.fields.length > 0
      ) {
        // Extract variable names from the capture struct fields
        const capturedVarNames = captureType.fields.map((field) => field.label);
        context.currentClosureCaptures = capturedVarNames;

        // Get the frame level - use the function's frame level as the capture frame level
        context.currentClosureCaptureFrameLevel = functionValue.frameLevel;

        // Get the C name of the capture type
        const captureTypeCName = context.types[captureType.id]?.cName;
        if (captureTypeCName) {
          (
            context as FunctionGenerationContext
          ).currentClosureCaptureTypeCName = captureTypeCName;
        }
      }
    }
  }

  // For ___dispose functions, check if the SelfType has a user-defined dispose method
  // from a Dispose trait and emit a call to it at the start of the function body.
  // This is done in codegen rather than the evaluator to handle traits added via impl
  // after the struct is defined.
  const isDisposeFunction =
    functionValue.funcName === BuiltinFunctions.___dispose[0];
  if (isDisposeFunction && functionType.SelfType) {
    const userDisposeCName = findUserDisposeMethodForType(
      functionType.SelfType,
      functionValue.type.env,
      context
    );
    if (userDisposeCName) {
      // Get the parameter name for __yo_self
      const selfParamName =
        functionType.parameters[0]?.label === "__yo_self"
          ? "__yo_self"
          : (functionType.parameters[0]?.label ?? "__yo_self");
      emitter.emitLine(
        `  ${userDisposeCName}(${selfParamName}); // Call user's dispose method`
      );
    }
  }

  // Generate function body with proper return handling
  generateFunctionBody(functionValue.body, functionType, "  ", context);

  // Restore previous function name, type, closure captures, and parameter aliases
  context.currentFunctionName = previousFunctionName;
  (context as FunctionGenerationContext).currentFunctionType =
    previousFunctionType;
  (context as FunctionGenerationContext).isModuleEffectMemberFunction =
    previousIsModuleEffectMemberFunction;
  (context as FunctionGenerationContext).overrideReturnTypeStr =
    previousOverrideReturnTypeStr;
  (context as FunctionGenerationContext).currentEvidenceParams =
    previousEvidenceParams;
  context.currentClosureCaptures = previousClosureCaptures;
  context.currentClosureCaptureFrameLevel = previousClosureCaptureFrameLevel;
  (context as FunctionGenerationContext).currentClosureType =
    previousClosureType;
  (context as FunctionGenerationContext).currentClosureCaptureTypeCName =
    previousClosureCaptureTypeCName;

  emitter.emitLine(`}`);
}

/**
 * Generate function body with proper return handling
 */
export function generateFunctionBody(
  expr: Expr,
  functionType: FunctionType,
  indent: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
  ) {
    // Handle begin block - generate all statements except the last, then return the last
    const args = expr.args;

    // Set pending deferred drops from the function body begin block
    // These need to be generated when early returning from anywhere inside this function
    context.pendingDeferredDrops = [...(expr.$?.deferredDropExpressions ?? [])];
    // Consumed variable drops: RC variables whose drops were optimized away because
    // they're consumed by the return value. Needed for escape propagation only.
    context.consumedVarPendingDrops = [
      ...(expr.$?.consumedVariableDropExpressions ?? []),
    ];

    // Generate all expressions except the last as statements
    let findReturn = false;
    for (let i = 0; i < args.length - 1; i++) {
      const arg = args[i]!;

      if (exprIsFunctionCallOf(arg, BuiltinKeywords.return)) {
        findReturn = true;
      }
      const argCode = generateExpr(arg, indent, context);
      if (
        argCode &&
        (!arg.$ || !isTempVariableName(arg.$.env.modulePath, argCode)) // Prevent emit meaningless line like `_yof4ca7ba3_temp_127;`
      ) {
        // Emit the expression as a statement
        emitter.emitLine(`${indent}${argCode};`);
      }

      if (findReturn) {
        break;
      }
    }

    // Generate the last expression as a return statement
    if (!findReturn && args.length > 0) {
      const lastExpr = args[args.length - 1];

      // Check if this is an async function - async functions return Impl(Future(T)) or Dyn(Future(T))
      const isAsyncFunction = typeImplementsFuture(functionType.return.type);

      if (isAsyncFunction && lastExpr) {
        // Check if the last expression is an async block
        // If it is, we should return it directly without wrapping
        const isAsyncBlock = isIoAsyncCall(lastExpr);

        // Check if the last expression already returns a Future type
        // If so, return it directly without wrapping (e.g., from Option.unwrap())
        const lastExprType = lastExpr.$?.type;
        const isAlreadyFuture =
          lastExprType && typeImplementsFuture(lastExprType);

        if (isAsyncBlock || isAlreadyFuture) {
          // Last expression is an async block or already returns a Future - return it directly
          const resultCode = generateExpr(lastExpr, indent, context);

          // Note: deferred dup expressions for async blocks are handled internally by generateAsyncBlock
          // so we don't need to generate them here

          // Generate deferred drop expressions for temporaries created in this function body
          // (e.g., Path.from_cstr creates a Path temp that needs dropping after the async call)
          if (
            expr.$?.deferredDropExpressions &&
            expr.$.deferredDropExpressions.length > 0 &&
            lastExprType
          ) {
            // Save the result to a temp variable, emit drops, then return
            // Use lastExprType (the concrete type) instead of functionType.return.type
            // (which may be Impl(Future) and not directly resolvable to a C type)
            const returnType = getTypeString(lastExprType, context);
            const tempVarName = `_yo_async_return_${Math.random().toString(36).substr(2, 9)}`;
            emitter.emitLine(
              `${indent}${returnType} ${tempVarName} = ${resultCode};`
            );
            generateDeferredDropExpressions(expr, indent, context);
            emitter.emitLine(`${indent}return ${tempVarName};`);
          } else {
            emitter.emitLine(`${indent}return ${resultCode};`);
          }
          return; // Exit early - we've handled the return
        } else {
          // FIXME: OUTDATED
          /// // For async functions, wrap the return value in a Future
          /// const futureType = functionType.return.type as FutureType;
          /// const childType = futureType.childType;
          /// const isUnitResult = isUnitType(childType);
          ///
          /// // Get the Future type C name
          /// const futureTypeCName = context.types[futureType.id]?.cName;
          /// if (!futureTypeCName) {
          ///   emitter.emitLine(
          ///     `${indent}// Error: Future type not found in context`
          ///   );
          ///   return;
          /// }
          ///
          /// // Generate the result expression (if not unit)
          /// if (!isUnitResult) {
          ///   const resultCode = generateExpr(lastExpr, indent, context);
          ///   emitter.emitLine(
          ///     `${indent}${getTypeString(childType, context)} _yo_async_result = ${resultCode};`
          ///   );
          /// } else {
          ///   // For unit, just execute the expression as a statement
          ///   const exprCode = generateExpr(lastExpr, indent, context);
          ///   if (exprCode) {
          ///     emitter.emitLine(`${indent}${exprCode};`);
          ///   }
          /// }
          ///
          /// // Allocate and initialize the Future
          /// emitter.emitLine(
          ///   `${indent}${futureTypeCName}* _yo_future = (${futureTypeCName}*)__yo_malloc(sizeof(${futureTypeCName}));`
          /// );
          /// emitter.emitLine(`${indent}_yo_future->header.ref_count = 1;`);
          /// emitter.emitLine(`${indent}_yo_future->header.gc_flags = 0;`);
          /// emitter.emitLine(
          ///   `${indent}_yo_future->header.gc_mark = YO_GC_UNMARKED;`
          /// );
          /// emitter.emitLine(`${indent}_yo_future->header.gc_next = NULL;`);
          /// emitter.emitLine(`${indent}_yo_future->header.gc_prev = NULL;`);
          /// emitter.emitLine(
          ///   `${indent}_yo_future->header.dispose_fn = yo_future_dispose;`
          /// );
          /// emitter.emitLine(`${indent}_yo_future->header.traverse_fn = NULL;`);
          /// emitter.emitLine(
          ///   `${indent}atomic_store_explicit(&_yo_future->state, YO_FUTURE_COMPLETED, memory_order_relaxed);`
          /// );
          /// emitter.emitLine(
          ///   `${indent}_yo_future->state_machine = NULL;  // No state machine for immediate completion`
          /// );
          ///
          /// if (!isUnitResult) {
          ///   emitter.emitLine(`${indent}_yo_future->result = _yo_async_result;`);
          /// }
          ///
          /// emitter.emitLine(`${indent}return _yo_future;`);
        }
      } else if (lastExpr && isUnitType(functionType.return.type)) {
        // For unit/void functions, generate the expression as a statement
        const exprCode = generateExpr(lastExpr, indent, context);
        if (exprCode) {
          emitter.emitLine(`${indent}${exprCode};`);
        }
        // Generate deferred drop expressions after the last statement
        generateDeferredDropExpressions(expr, indent, context);
      } else if (lastExpr) {
        // Check if the last expression has control flow (like return statements)
        const exprHasControlFlow = hasAnyControlFlow(lastExpr.$?.controlFlow);

        // Check if last expr is unit - either by type or by being a tuple() call with no args
        const isLastExprUnit =
          isUnitType(lastExpr.$?.type) ||
          (exprIsFunctionCall(lastExpr) &&
            exprIsFunctionCallOf(lastExpr, BuiltinKeywords.tuple) &&
            lastExpr.args.length === 0);
        const prevExpr = args.length > 1 ? args[args.length - 2] : null;
        const prevExprHasControlFlow = hasAnyControlFlow(
          prevExpr?.$?.controlFlow
        );

        if (isLastExprUnit && prevExprHasControlFlow) {
          // Don't generate return for unit if previous expression has control flow or is borrow
          // Skip generating anything - the control flow already happened in the previous expression
        } else if (exprHasControlFlow) {
          // If the expression has control flow or is a borrow, just generate it without adding a return
          const exprCode = generateExpr(lastExpr, indent, context);
          if (exprCode) {
            emitter.emitLine(`${indent}${exprCode};`);
          }
        } else {
          // Generate deferred dup expressions for the last expression (e.g., field access that needs duping)
          if (
            lastExpr.$?.deferredDupExpressions &&
            lastExpr.$.deferredDupExpressions.length > 0
          ) {
            // First, generate the expression and store it in its temp variable
            if (lastExpr.$?.variableName) {
              // const exprType = getTypeString(lastExpr.$.type!, context);
              // Use the function's return type instead of expression type for specialized functions
              // because the expression type might still have unresolved type parameters
              const exprType = getTypeString(functionType.return.type, context);
              const exprTempVar = getVariableNameForCodegen(
                lastExpr.$.variableName,
                lastExpr.$.env
              );
              const rawCode = generateExpr(lastExpr, indent, context);
              if (exprTempVar !== rawCode) {
                emitter.emitLine(
                  `${indent}${exprType} ${exprTempVar} = ${rawCode};`
                );
              }
            }

            // Then generate the deferred dup expressions
            generateDeferredDupExpressions(lastExpr, indent, context);

            // Use the duped value's variable name for the return
            const dupExpr = lastExpr.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              const dupedValue = sanitizeForCIdentifier(dupExpr.$.variableName);
              // Then generate deferred drop expressions for the begin block before the return
              generateDeferredDropExpressions(expr, indent, context);
              // Finally, emit the return statement
              emitter.emitLine(`${indent}return ${dupedValue};`);
              return;
            }
          }

          // For other functions, generate the expression first
          const exprCode = generateExpr(lastExpr, indent, context);

          // Then generate deferred drop expressions before the return
          generateDeferredDropExpressions(expr, indent, context);

          // Finally, emit the return statement
          if (exprCode) {
            emitter.emitLine(`${indent}return ${exprCode};`);
          }
        }
      }
    } else if (findReturn && args.length > 0) {
      // We found an explicit return statement, but there might be a trailing unit expression
      // that we should ignore (don't generate as a statement)
      const lastExpr = args[args.length - 1];
      if (lastExpr && isUnitType(lastExpr.$?.type)) {
        // Ignore trailing unit expressions after explicit return
        // Don't generate anything for this
      }
    }
  } else {
    // Generate deferred drop expressions before the return statement
    generateDeferredDropExpressions(expr, indent, context);

    // Single expression function body
    if (isUnitType(functionType.return.type)) {
      // For unit/void functions, generate the expression as a statement
      const exprCode = generateExpr(expr, indent, context);
      if (exprCode) {
        emitter.emitLine(`${indent}${exprCode};`);
      }
    } else {
      // For other functions, return the expression
      generateImplicitReturnStatement(expr, indent, context);
    }
  }
}

/**
 * Generate the bodies of specialized (monomorphized) functions
 */
export function generateSpecializedFunctions(context: CodeGenContext): void {
  for (const funcId in context.functions) {
    const { value: functionValue, cName: cFunctionName } =
      context.functions[funcId]!;

    if (isComptimeFunction(functionValue)) {
      // Skip compile-time only functions
      continue;
    }

    // Skip if not a generic function
    if (
      !functionValue.specializedType ||
      !isFunctionTypeGeneric(functionValue.type)
    ) {
      continue;
    }

    // Skip if the specialized type still has unresolved type parameters
    // Don't use isFunctionTypeGeneric — it treats implicitParameters as generic,
    // but resolved implicit params (from spread evidence) are NOT generic.
    const st = functionValue.specializedType;
    const hasForallOrCompileTimeSpec =
      st.forallParameters.length > 0 ||
      st.parameters.some((p) => p.isCompileTimeOnly);
    const hasSomeTypeParamsSpec = st.parameters.some(
      (p) =>
        !p.isCompileTimeOnly &&
        isSomeType(p.type) &&
        !typeImplementsFuture(p.type)
    );
    if (hasForallOrCompileTimeSpec || hasSomeTypeParamsSpec) {
      continue;
    }

    // Also skip if any parameter type contains SomeType (generic type parameters)
    // This happens when a function specialization wasn't completed properly
    const hasGenericParams = functionValue.specializedType.parameters.some(
      (p) => typeContainsSomeType(p.type)
    );
    const hasGenericReturnType = typeContainsSomeType(
      functionValue.specializedType.return.type
    );
    if (hasGenericParams || hasGenericReturnType) {
      continue;
    }

    // If this function is effectful, the main loop already generated it
    // with evidence passing. Skip to avoid redefinition.
    const effectAnalysis = functionValue.body?.$?.effectAnalysis;
    if (effectAnalysis && effectAnalysis.hasEffects) {
      continue;
    }

    // Module effect member functions (e.g., specialized ctl handlers like throw_ctl_unit)
    // are already generated in generateAllFunctions. Skip to avoid redefinition.
    if (functionValue.isModuleEffectMember) {
      continue;
    }

    // If this function has evidence parameters, the main loop already generated
    // its body with evidence passing (fn ptr params). Skip to avoid redefinition.
    const evidenceParams = getEvidenceParameters(
      functionValue.specializedType ?? functionValue.type
    );
    if (evidenceParams.length > 0) {
      continue;
    }

    // Generate the specialized function body
    generateFunction(functionValue, cFunctionName, context);
  }
}

/**
 * Generate non-atomic reference counting runtime functions.
 * Generate thread-local garbage collection with QuickJS-style trial deletion for cycle collection.
 * See CYCLE_COLLECTION.md for design details.
 */
function generateAtomicGCRuntimeFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate simple non-atomic __yo_decr_rc and __yo_incr_rc functions
  emitter.emitLine(`// Non-atomic reference counting functions (thread-local)
void __yo_decr_rc(void* ptr) {
  if (ptr == NULL) return;
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // Skip if this object is marked as garbage by the GC.
  // During GC collection, dispose functions may call ___drop on children,
  // but those children are also being collected by the GC.
  // The GC is responsible for freeing garbage objects, not the RC system.
  if ((header->gc_flags & YO_GC_TRACKED) && header->gc_mark == YO_GC_GARBAGE) {
    GC_DEBUG("Decr: Skipping ptr=%p (marked as GC garbage)\\n", ptr);
    return;
  }
  
  GC_DEBUG("Decr: ptr=%p RC=%zu->%zu\\n", ptr, header->ref_count, header->ref_count - 1);
  
  if (header->ref_count == 1) {
    // Last reference - deallocate immediately without decrementing
    GC_DEBUG("Decr: Deallocating ptr=%p (last ref)\\n", ptr);
    __yo_gc_unregister(ptr);
    if (header->dispose_fn) {
      header->dispose_fn(ptr);
    }
    __yo_free(ptr);
  } else {
    // More than one reference - just decrement
    header->ref_count--;
  }
}

void* __yo_incr_rc(void* ptr) {
  if (ptr == NULL) return NULL;
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  header->ref_count++;
  GC_DEBUG("Incr: ptr=%p RC=%zu\\n", ptr, header->ref_count);
  return ptr;
}`);

  // Atomic reference counting functions for Iso types (thread-safe)
  emitter.emitLine(`
// Atomic reference counting functions for Iso types (thread-safe)
void* __yo_incr_rc_atomic(void* ptr) {
  if (ptr == NULL) return NULL;
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  atomic_fetch_add(((_Atomic size_t*)&header->ref_count), 1);
  return ptr;
}

void __yo_decr_rc_atomic(void* ptr) {
  if (ptr == NULL) return;
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  size_t old_count = atomic_fetch_sub(((_Atomic size_t*)&header->ref_count), 1);
  
  if (old_count == 1) {
    // Last reference - deallocate
    // Note: No GC tracking needed for Iso types (they don't participate in cycles)
    if (header->dispose_fn) {
      header->dispose_fn(ptr);
    }
    __yo_free(ptr);
  }
}`);

  // Per-thread GC tracking state (simplified - no stop-the-world coordination needed for thread-local)
  // Effect escape flag and value buffer are emitted in declaration section
  // (via emitDeclarationLine) so they're available to sync_fut_t resume functions.
  emitter.emitDeclarationLine(
    `static _Thread_local int __yo_effect_escaped = 0;  // Thread-local flag for module effect escape detection`
  );
  emitter.emitDeclarationLine(
    `static _Thread_local _Alignas(16) char __yo_effect_escape_value[64];  // Thread-local buffer for escape value storage`
  );
  emitter.emitLine(`// Per-thread GC tracking state for cycle collection
static _Thread_local yo_thread_gc_state_t* yo_current_thread_gc = NULL;  // Current thread's GC state
static yo_thread_gc_state_t* yo_all_thread_gcs = NULL;  // Global list of all thread GC states (for cleanup)
#if defined(_WIN32)
static YO_THREAD_SYNC_TYPE yo_thread_list_mutex;
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
static YO_THREAD_SYNC_TYPE yo_thread_list_mutex = YO_THREAD_SYNC_INIT;
#endif
static size_t yo_gc_min_threshold = 256;       // Minimum threshold for adaptive scaling
static size_t yo_gc_collect_threshold = 256;   // Adaptive: starts at min, grows to 2x live objects after each GC

// Thread cleanup infrastructure
#if defined(_WIN32)
// Windows: Use native TLS API instead of C11 tss_t (better compiler support)
static DWORD yo_thread_cleanup_key = TLS_OUT_OF_INDEXES;
static volatile LONG yo_thread_cleanup_init_started = 0;
static volatile LONG yo_thread_cleanup_init_done = 0;

static void yo_init_thread_cleanup_key(void) {
  // Simple once-only initialization using interlocked operations
  if (InterlockedCompareExchange(&yo_thread_cleanup_init_started, 1, 0) == 0) {
    yo_thread_cleanup_key = TlsAlloc();
    InterlockedExchange(&yo_thread_cleanup_init_done, 1);
  } else {
    // Wait for initialization to complete
    while (InterlockedCompareExchange(&yo_thread_cleanup_init_done, 1, 1) == 0) {
      Sleep(0);
    }
  }
}
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
static pthread_key_t yo_thread_cleanup_key = (pthread_key_t)(-1);
static pthread_once_t yo_thread_cleanup_once = PTHREAD_ONCE_INIT;

static void yo_pthread_cleanup(void* value) {
  if (value != NULL) {
    __yo_cleanup_thread_gc();
  }
}

static void yo_init_thread_cleanup_key(void) {
  pthread_key_create(&yo_thread_cleanup_key, yo_pthread_cleanup);
}
#endif

// Initialize thread-local GC state
static void yo_init_thread_gc() {
  if (yo_current_thread_gc != NULL) return;

#if defined(_WIN32)
  yo_init_thread_cleanup_key();
  if (yo_thread_cleanup_key != TLS_OUT_OF_INDEXES) {
    TlsSetValue(yo_thread_cleanup_key, (void*)1);
  }
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
  pthread_once(&yo_thread_cleanup_once, yo_init_thread_cleanup_key);
  if (yo_thread_cleanup_key != (pthread_key_t)(-1)) {
    pthread_setspecific(yo_thread_cleanup_key, (void*)1);
  }
#endif
  
  yo_init_process_cleanup();

  yo_current_thread_gc = (yo_thread_gc_state_t*)__yo_malloc(sizeof(yo_thread_gc_state_t));
  yo_current_thread_gc->tracked_objects = NULL;
  yo_current_thread_gc->tracked_count = 0;
  yo_current_thread_gc->thread_id = yo_thread_self();
  yo_current_thread_gc->alloc_count = 0;

  // Add to global thread list (for cleanup coordination)
  yo_mutex_lock(&yo_thread_list_mutex);
  yo_current_thread_gc->next = yo_all_thread_gcs;
  yo_current_thread_gc->prev = NULL;
  if (yo_all_thread_gcs != NULL) {
    yo_all_thread_gcs->prev = yo_current_thread_gc;
  }
  yo_all_thread_gcs = yo_current_thread_gc;
  yo_mutex_unlock(&yo_thread_list_mutex);
}

// Public function to initialize thread-local GC (for worker threads)
void __yo_gc_init_thread() {
  yo_init_thread_gc();
}`);

  // Generate __yo_gc_register and __yo_gc_unregister functions
  emitter.emitLine(`void __yo_gc_register(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  if (yo_current_thread_gc == NULL) {
    yo_init_thread_gc();
  }
  
  GC_DEBUG("GC Register: ptr=%p\\n", ptr);
  
  // Check if already tracked
  if (header->gc_flags & YO_GC_TRACKED) {
    return;
  }
  
  header->gc_flags |= YO_GC_TRACKED;
  header->gc_mark = YO_GC_UNMARKED;
  
  // Add to thread-local tracking list
  header->gc_next = yo_current_thread_gc->tracked_objects;
  header->gc_prev = NULL;
  if (yo_current_thread_gc->tracked_objects != NULL) {
    yo_current_thread_gc->tracked_objects->gc_prev = header;
  }
  yo_current_thread_gc->tracked_objects = header;
  yo_current_thread_gc->tracked_count++;
  
  // Check if we should trigger GC
  if (yo_current_thread_gc->tracked_count >= yo_gc_collect_threshold) {
    __yo_gc_collect();
  }
}

void __yo_gc_unregister(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  if (yo_current_thread_gc == NULL) {
    return;
  }
  
  if (!(header->gc_flags & YO_GC_TRACKED)) {
    return;
  }
  
  // Remove from tracking list (O(1) with doubly-linked list)
  if (header->gc_prev != NULL) {
    header->gc_prev->gc_next = header->gc_next;
  } else {
    yo_current_thread_gc->tracked_objects = header->gc_next;
  }
  
  if (header->gc_next != NULL) {
    header->gc_next->gc_prev = header->gc_prev;
  }

  yo_current_thread_gc->tracked_count--;
  header->gc_flags &= ~YO_GC_TRACKED;
}`);

  // Generate QuickJS-style trial deletion cycle collection
  emitter.emitLine(`// QuickJS-style trial deletion for cycle collection
// Phase 1: Trial deletion - decrement ref counts for internal references
static void yo_gc_trial_delete_visitor(void* ptr) {
  if (ptr == NULL) return;
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // Only process tracked objects
  if (!(header->gc_flags & YO_GC_TRACKED)) return;
  
  // Trial decrement
  if (header->ref_count > 0) {
    header->ref_count--;
    GC_DEBUG("TrialDelete: ptr=%p, ref_count->%zu\\n", ptr, header->ref_count);
  }
}

// Phase 2: Restore ref counts for live objects
static void yo_gc_restore_visitor(void* ptr) {
  if (ptr == NULL) return;
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // Only restore for objects that were trial-deleted
  if (header->gc_mark == YO_GC_LIVE) {
    header->ref_count++;
    GC_DEBUG("Restore: ptr=%p, ref_count->%zu\\n", ptr, header->ref_count);
  }
}

void __yo_gc_collect() {
  if (yo_current_thread_gc == NULL) return;
  
  yo_ref_header_t* head = yo_current_thread_gc->tracked_objects;
  if (head == NULL) return;
  
  GC_DEBUG("GC: Starting collection, tracked_count=%zu\\n", yo_current_thread_gc->tracked_count);
  
  size_t collected = 0;
  
  // Phase 1: Mark all as candidates and trial-delete
  yo_ref_header_t* obj = head;
  while (obj != NULL) {
    obj->gc_mark = YO_GC_CANDIDATE;
    obj = obj->gc_next;
  }
  
  // Trial deletion: decrement RC for all internal references
  obj = head;
  while (obj != NULL) {
    if (obj->traverse_fn) {
      obj->traverse_fn(obj, yo_gc_trial_delete_visitor);
    }
    obj = obj->gc_next;
  }
  
  // Phase 2: Identify garbage (RC == 0) and live objects (RC > 0)
  obj = head;
  while (obj != NULL) {
    if (obj->ref_count == 0) {
      obj->gc_mark = YO_GC_GARBAGE;
      GC_DEBUG("GC: Marked as garbage: ptr=%p\\n", obj);
    } else {
      obj->gc_mark = YO_GC_LIVE;
      GC_DEBUG("GC: Marked as live: ptr=%p (ref_count=%zu)\\n", obj, obj->ref_count);
    }
    obj = obj->gc_next;
  }
  
  // Phase 3: Restore ref counts for live objects
  obj = head;
  while (obj != NULL) {
    if (obj->gc_mark == YO_GC_LIVE && obj->traverse_fn) {
      obj->traverse_fn(obj, yo_gc_restore_visitor);
    }
    obj = obj->gc_next;
  }
  
  // Phase 4a: Call dispose functions on all garbage objects (while memory is still valid)
  // This must happen before freeing any objects, because dispose functions may try
  // to access other garbage objects (e.g., to check gc_mark in __yo_decr_rc).
  obj = head;
  while (obj != NULL) {
    if (obj->gc_mark == YO_GC_GARBAGE && obj->dispose_fn) {
      GC_DEBUG("GC: Disposing garbage: ptr=%p\\n", obj);
      obj->dispose_fn(obj);
    }
    obj = obj->gc_next;
  }
  
  // Phase 4b: Free all garbage objects and remove from tracking list
  yo_ref_header_t* current = head;
  yo_ref_header_t* prev = NULL;
  
  while (current != NULL) {
    yo_ref_header_t* next = current->gc_next;
    
    if (current->gc_mark == YO_GC_GARBAGE) {
      GC_DEBUG("GC: Freeing garbage: ptr=%p\\n", current);
      
      // Remove from tracking list
      if (prev == NULL) {
        yo_current_thread_gc->tracked_objects = next;
      } else {
        prev->gc_next = next;
      }
      if (next != NULL) {
        next->gc_prev = prev;
      }
      
      yo_current_thread_gc->tracked_count--;
      collected++;
      
      // Free the object (dispose was already called in Phase 4a)
      __yo_free(current);
      
      current = next;
    } else {
      // Reset mark for next collection
      current->gc_mark = YO_GC_UNMARKED;
      prev = current;
      current = next;
    }
  }
  
  // Adaptive threshold: set to max(min_threshold, 2 * remaining_objects)
  size_t new_threshold = yo_current_thread_gc->tracked_count * 2;
  if (new_threshold < yo_gc_min_threshold) {
    new_threshold = yo_gc_min_threshold;
  }
  yo_gc_collect_threshold = new_threshold;
  
  GC_DEBUG("GC: Collection complete, collected=%zu, remaining=%zu, next_threshold=%zu\\n", collected, yo_current_thread_gc->tracked_count, yo_gc_collect_threshold);
}

size_t __yo_gc_tracked_count() {
  if (yo_current_thread_gc == NULL) return 0;
  return yo_current_thread_gc->tracked_count;
}`);

  // Generate thread cleanup function
  emitter.emitLine(`// Clean up thread-local GC state
void __yo_cleanup_thread_gc() {
  yo_mutex_lock(&yo_thread_list_mutex);
  
  yo_thread_gc_state_t* my_gc_state = yo_current_thread_gc;
  
  if (my_gc_state == NULL) {
    yo_mutex_unlock(&yo_thread_list_mutex);
    return;
  }
  
  GC_DEBUG("CleanupThread: tracked_count=%zu\\n", my_gc_state->tracked_count);
  
  // Force dispose all remaining tracked objects
  yo_ref_header_t* current = my_gc_state->tracked_objects;
  while (current != NULL) {
    yo_ref_header_t* next = current->gc_next;
    
    GC_DEBUG("CleanupThread: Disposing object ptr=%p\\n", current);
    if (current->dispose_fn) {
      current->dispose_fn(current);
    }
    __yo_free(current);
    
    current = next;
  }
  
  // Remove from global list
  if (my_gc_state->prev != NULL) {
    my_gc_state->prev->next = my_gc_state->next;
  } else {
    yo_all_thread_gcs = my_gc_state->next;
  }
  
  if (my_gc_state->next != NULL) {
    my_gc_state->next->prev = my_gc_state->prev;
  }
  
  yo_mutex_unlock(&yo_thread_list_mutex);
  
  __yo_free(my_gc_state);
  yo_current_thread_gc = NULL;
}

// Process cleanup
static void yo_process_cleanup(void) {
  GC_DEBUG("ProcessCleanup: Called\\n");
  
  if (yo_current_thread_gc != NULL) {
    __yo_gc_collect();
    __yo_cleanup_thread_gc();
  }
  
#if defined(_WIN32)
  if (yo_thread_cleanup_key != TLS_OUT_OF_INDEXES) {
    TlsFree(yo_thread_cleanup_key);
    yo_thread_cleanup_key = TLS_OUT_OF_INDEXES;
  }
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
  if (yo_thread_cleanup_key != (pthread_key_t)(-1)) {
    pthread_key_delete(yo_thread_cleanup_key);
  }
#endif
}

#if defined(_WIN32)
static INIT_ONCE yo_process_cleanup_once = INIT_ONCE_STATIC_INIT;
static BOOL CALLBACK yo_process_cleanup_init_callback(PINIT_ONCE InitOnce, PVOID Parameter, PVOID *Context) {
  (void)InitOnce; (void)Parameter; (void)Context;
  InitializeCriticalSection(&yo_thread_list_mutex);
  atexit(yo_process_cleanup);
  return TRUE;
}
#endif

static void yo_init_process_cleanup(void) {
#if defined(_WIN32)
  InitOnceExecuteOnce(&yo_process_cleanup_once, yo_process_cleanup_init_callback, NULL, NULL);
#else
  static bool cleanup_initialized = false;
  if (cleanup_initialized) return;
  cleanup_initialized = true;
  atexit(yo_process_cleanup);
#endif
}`);
}

/**
 * Generate traversal functions for objects (used by GC for marking)
 */
function generateRefStructTraversalFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (isStructType(type) && type.isReferenceSemantics) {
      // Skip generic structs that contain SomeType parameters
      const hasGenericTypes = type.fields.some((field) =>
        typeContainsSomeType(field.type)
      );

      if (hasGenericTypes) {
        continue; // Skip generic structs
      }

      // Generate traversal function for this struct type
      const traversalFunctionName = `__yo_traverse_${cName}`;
      emitter.emitLine(
        `void ${traversalFunctionName}(void* ptr, void (*visit)(void*)) {`
      );
      emitter.emitLine(`  ${cName}* obj = (${cName}*)ptr;`);

      // Visit each reference field in the struct
      for (const field of type.fields) {
        const fieldName = sanitizeForCIdentifier(field.label);
        const fieldType = field.type;

        if (isStructType(fieldType) && fieldType.isReferenceSemantics) {
          // This field is a direct reference to another object
          emitter.emitLine(`  if (obj->${fieldName}) {`);
          emitter.emitLine(`    visit(obj->${fieldName});`);
          emitter.emitLine(`  }`);
        } else if (isEnumType(fieldType)) {
          // This field is an enum - we need to check if any variants contain references
          const enumType = fieldType as EnumType;

          // Check if this enum is optimized as a nullable pointer
          const nullablePointerType = canOptimizeAsNullablePointer(enumType);

          if (nullablePointerType) {
            // This is a nullable pointer optimization - just check if it's non-null
            // No need to visit the pointer itself since it's not a reference-counted object
            // (it's just a raw pointer or primitive value wrapped in Option)
          } else if (canOptimizeAsSimpleEnum(enumType)) {
            // Simple enums have no variant data, so no references to traverse
          } else {
            // Generate switch statement to handle enum variants
            emitter.emitLine(`  switch (obj->${fieldName}.tag) {`);

            for (const variant of enumType.variants || []) {
              // Check if any of the variant's fields contain references
              if (variant.fields && variant.fields.length > 0) {
                for (const variantField of variant.fields) {
                  if (
                    isStructType(variantField.type) &&
                    variantField.type.isReferenceSemantics
                  ) {
                    // This variant contains a reference
                    const enumConstantName = `YO_${enumType.id?.toUpperCase()}_${variant.name.toUpperCase()}`;
                    emitter.emitLine(`  case ${enumConstantName}:`);
                    emitter.emitLine(
                      `    if (obj->${fieldName}.data.${variant.name}.${sanitizeForCIdentifier(variantField.label)}) {`
                    );
                    emitter.emitLine(
                      `      visit(obj->${fieldName}.data.${variant.name}.${sanitizeForCIdentifier(variantField.label)});`
                    );
                    emitter.emitLine(`    }`);
                    emitter.emitLine(`    break;`);
                    break; // Only generate one case per variant
                  }
                }
              }
            }

            emitter.emitLine(`  }`);
          }
        }
      }
      emitter.emitLine(`}`);
      emitter.emitLine(``);
    }
  }
}

/**
 * Generate constructor function implementations for objects and ref enums
 */
export function generateRefStructConstructorFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // First, generate traversal functions for each object type
  generateRefStructTraversalFunctions(context);

  // Generate constructor implementations for each object
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

      // Generate constructor function implementation
      const constructorName = `__yo_new_${cName}`;
      const paramTypes = type.fields
        .map((field) => {
          const fieldType = getTypeString(field.type, context);
          const fieldName = sanitizeForCIdentifier(field.label);
          return `${fieldType} ${fieldName}`;
        })
        .join(", ");

      emitter.emitLine(`${cName}* ${constructorName}(${paramTypes}) {`);
      emitter.emitLine(
        `  ${cName}* obj = (${cName}*)__yo_malloc(sizeof(${cName}));`
      );
      // Initialize non-atomic RC fields
      emitter.emitLine(
        `  obj->header.ref_count = 1;  // Start with one reference`
      );
      emitter.emitLine(`  obj->header.gc_flags = 0;`);
      emitter.emitLine(`  obj->header.gc_mark = YO_GC_UNMARKED;`);
      emitter.emitLine(`  obj->header.gc_next = NULL;`);
      emitter.emitLine(`  obj->header.gc_prev = NULL;`);

      // Set dispose function pointer to ___dispose, which handles both user cleanup and field dropping.
      // ___dispose will call user's dispose() if it exists, then drop all GC-containing fields.
      const disposeInternalFunctionElement = type.trait.fields.find(
        (field) =>
          field.label === BuiltinFunctions.___dispose[0]! &&
          field.assignedValue &&
          isFunctionValue(field.assignedValue)
      );

      if (
        disposeInternalFunctionElement &&
        isFunctionValue(disposeInternalFunctionElement.assignedValue)
      ) {
        const disposeFunctionValue =
          disposeInternalFunctionElement.assignedValue;
        const disposeFunctionCName =
          context.functions[disposeFunctionValue.funcId]?.cName ||
          disposeFunctionValue.funcId;
        emitter.emitLine(
          `  obj->header.dispose_fn = (void(*)(void*))${disposeFunctionCName};`
        );
      } else {
        // Fallback to NULL if no ___dispose function found
        emitter.emitLine(`  obj->header.dispose_fn = NULL;`);
      }

      // Set traversal function pointer for GC
      const traversalFunctionName = `__yo_traverse_${cName}`;
      emitter.emitLine(`  obj->header.traverse_fn = ${traversalFunctionName};`);

      // Initialize fields
      type.fields.forEach((field) => {
        const fieldName = sanitizeForCIdentifier(field.label);
        emitter.emitLine(`  obj->${fieldName} = ${fieldName};`);
      });

      // Register with GC if this type might participate in cycles
      if (canTypeFormRcCycle(type, new Set(), type.env)) {
        emitter.emitLine(`  __yo_gc_register(obj);`);
      }

      emitter.emitLine(`  return obj;`);
      emitter.emitLine(`}`);
      emitter.emitLine(``);
    }
  }
}

/**
 * Generate constructor function implementations for closures and their Rc functions
 */
export function generateClosureConstructorFunctions(
  context: FunctionGenerationContext
): void {
  // No-op: Impl(Fn(...)) closures use concrete capture structs + direct calls.
  // Dyn(Fn(...)) uses dyn constructors (generated elsewhere).
  void context;
}

/**
 * Generate dispose functions for closures
 * Each closure instance (closure type + capture type combination) gets its own dispose function
 * that handles cleanup of its specific capture type.
 *
 * The dispose function:
 * 1. Receives a closure pointer (void*)
 * 2. Casts it to the specific closure type
 * 3. Casts the closure->data to the specific capture type
 * 4. Calls the capture type's drop function
 * 5. Frees the capture data
 */
export function generateClosureDisposeFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  if (!context.closureCaptureMap || context.closureCaptureMap.size === 0) {
    return;
  }

  emitter.emitLine(
    `// Closure dispose functions - one per closure instance (closure type + capture type)`
  );
  emitter.emitLine(``);

  // First, emit forward declarations to the declaration section
  for (const [closureInstanceId] of context.closureCaptureMap) {
    const disposeFunctionName = `__yo_dispose_closure_${closureInstanceId}`;
    emitter.emitDeclarationLine(
      `void ${disposeFunctionName}(void* closure_ptr);`
    );
  }

  // Then generate function implementations
  for (const [
    closureInstanceId,
    { closureCName, captureType, captureCName },
  ] of context.closureCaptureMap) {
    const disposeFunctionName = `__yo_dispose_closure_${closureInstanceId}`;

    // Get the drop function for the capture type
    const dropFunction = captureType.trait.fields.find(
      (field) => field.label === BuiltinFunctions.___drop[0]
    );

    if (!dropFunction || !dropFunction.assignedValue) {
      continue; // Skip if no drop function
    }

    if (!isFunctionValue(dropFunction.assignedValue)) {
      continue;
    }

    const dropFunctionValue = dropFunction.assignedValue;
    const dropFunctionCName =
      context.functions[dropFunctionValue.funcId]?.cName;

    if (!dropFunctionCName) {
      continue; // Skip if drop function C name not found
    }

    // Generate the dispose function for Impl closures (value types)
    // For Impl closures, captures are stack-allocated, so we only call drop, NOT free
    // Signature: void dispose(void* closure_ptr)
    // This function receives the CLOSURE pointer (not capture pointer),
    // extracts the capture data, and calls drop (no free needed for stack-allocated capture)
    emitter.emitLine(
      `void ${disposeFunctionName}(void* closure_ptr) { // Dispose for ${closureCName} with ${captureCName} (Impl closure - value type)`
    );
    emitter.emitLine(`  if (closure_ptr) {`);
    emitter.emitLine(
      `    ${closureCName}* closure = (${closureCName}*)closure_ptr;`
    );
    emitter.emitLine(`    if (closure->data) {`);
    emitter.emitLine(
      `      ${dropFunctionCName}(*(${captureCName}*)closure->data); // Drop the capture struct (dereference pointer to pass by value)`
    );
    emitter.emitLine(
      `      // Note: capture data is stack-allocated for Impl closures, no __yo_free needed`
    );
    emitter.emitLine(`    }`);
    emitter.emitLine(`  }`);
    emitter.emitLine(`}`);
    emitter.emitLine(``);
  }
}
