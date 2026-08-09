import { getVariablesFromEnvByFilter } from "../../env";
import { isIoAwaitCall } from "../../evaluator/async/await-analysis";
import {
  extractFutureTraitFromType,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import { exprIsFunctionCall, type FnCallExpr } from "../../expr";
import type {
  SourceNamespaceType,
  StructType,
  Type,
} from "../../types/definitions";
import {
  isEnumType,
  isFunctionType,
  isSourceNamespaceType,
  isSomeType,
  isStructType,
  isUnitType,
} from "../../types/guards";
import { typeContainsRcType } from "../../types/utils";
import { isFunctionValue, isStructValue } from "../../value";
import { isIoFutureType } from "../async/state-machine";
import type { FunctionGenerationContext } from "../functions/context";
import {
  getDeferredDropTargetAtomName,
  getEnumVariantCName,
  getTypeString,
  getVariableTypeString,
  type CodeGenContext,
  quoteCString,
} from "../utils";
import { getDupFunctionForType } from "./drop-dup";
import { generateExpr } from "./expr";
import { generatePendingDeferredDrops } from "./return";

/**
 * await - extract value from Future
 */
export function generateAwait(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const futureArg = expr.args[0];
  if (!futureArg) {
    return `// Error: await requires exactly 1 argument`;
  }

  const futureType = futureArg.$?.type;

  // Check if the type implements Future (handles both FutureTraitType and SomeType with Future impl)
  if (!futureType || !typeImplementsFuture(futureType)) {
    return `// Error: await argument must be a Future type`;
  }

  // Extract the Future trait type to get the result type.
  const futureTraitType = extractFutureTraitFromType(futureType);
  if (!futureTraitType) {
    return `// Error: could not extract Future trait from type`;
  }

  // In async context (state machine), await expressions don't generate code
  // The result is extracted at the start of the next state
  // If this await expression is assigned to a variable, that variable's name is in expr.$.variableName
  const functionContext = context as FunctionGenerationContext;
  if (
    functionContext.inAsyncStateMachine ||
    functionContext.inEffectStateMachine
  ) {
    // An await in a non-splittable position (a `cond`/`if` condition, a `match`
    // scrutinee) was hoisted across the state boundary: its result is already
    // extracted and live in this state, so the await stands for that value.
    // Without this the empty string below becomes an empty operand — the
    // `sm->var_N = ;` that used to reach the C compiler.
    const substitution = functionContext.awaitResultSubstitutions?.get(expr);
    if (substitution !== undefined) {
      return substitution;
    }

    // Return empty string - the actual await logic is handled by state machine generator
    // The result will be available in the target variable in the next state
    return ``;
  }

  // For io.await outside a state machine, generate synchronous blocking wait
  if (isIoAwaitCall(expr)) {
    const futureCode = generateExpr(futureArg, indent, context);
    const futureTypeName = getTypeString(futureType, context);
    let resultType = futureTraitType.isFuture.outputType;

    // Resolve SomeType to concrete type for the await result.
    if (isSomeType(resultType)) {
      if (resultType.resolvedConcreteType) {
        resultType = resultType.resolvedConcreteType;
      } else if (expr.$?.type && !isSomeType(expr.$.type)) {
        resultType = expr.$.type;
      } else if (
        expr.$?.type &&
        isSomeType(expr.$.type) &&
        expr.$.type.resolvedConcreteType
      ) {
        resultType = expr.$.type.resolvedConcreteType;
      }
    }
    const emitter = functionContext.emitter;

    // When the output type is an unresolved SomeType (e.g., from generic(T) in
    // io.await's signature evaluated with io=UnknownValue), check if the await
    // call expression's type gives us a more concrete result.
    const isResultUnit =
      isUnitType(resultType) ||
      (isSomeType(resultType) && isUnitType(expr.$?.type ?? resultType));

    // Use a unique variable name per io.await call to avoid redefinition errors
    const syncFutureVar = expr.$?.variableName
      ? `__sync_future_${expr.$.variableName}`
      : `__sync_future`;
    const preAwaitStateVar = expr.$?.variableName
      ? `__pre_await_state_${expr.$.variableName}`
      : `__pre_await_state`;

    emitter.emitLine(
      `${indent}// Synchronous await (io.await outside state machine)`
    );
    emitter.emitLine(
      `${indent}${futureTypeName} ${syncFutureVar} = ${futureCode};`
    );
    // Save state before cold-start to distinguish "already aborted" from
    // "aborted during this await by an effect handler"
    emitter.emitLine(
      `${indent}int ${preAwaitStateVar} = ${syncFutureVar}->state;`
    );
    // Only cold-start state machine futures; Io futures are already submitted to io_uring
    const isIoFuture = isIoFutureType(futureArg.$?.type);
    if (!isIoFuture) {
      emitter.emitLine(
        `${indent}if (${preAwaitStateVar} == 0 && ${syncFutureVar}->__yo_resume_fn) {`
      );
      // Inject effect handler values into capture struct before cold-starting
      emitEffectInjectionForAwait(expr, syncFutureVar, indent, context);
      emitter.emitLine(
        `${indent}  __yo_incr_rc((void*)${syncFutureVar});  // event loop reference`
      );
      emitter.emitLine(
        `${indent}  ${syncFutureVar}->__yo_resume_fn((void*)${syncFutureVar});`
      );
      emitter.emitLine(`${indent}}`);
    }
    emitter.emitLine(`${indent}{`);
    emitter.emitLine(`${indent}  int __await_state = ${syncFutureVar}->state;`);
    emitter.emitLine(
      `${indent}  while (__await_state != -1 && __await_state != -2) {`
    );
    emitter.emitLine(`${indent}    __yo_async_poll_step();`);
    emitter.emitLine(`${indent}    __await_state = ${syncFutureVar}->state;`);
    emitter.emitLine(`${indent}  }`);
    emitter.emitLine(`${indent}  if (__await_state == -2) {`);
    // Check if the Future type includes algebraic effect types (e.g., Future(i32, Io, Raise))
    // or effect record types (e.g., Future(i32, Io, Exception)).
    // Effectful futures may be intentionally aborted by a ctl/unwind handler
    // during the CURRENT await — don't panic for that case.
    // But if the future was ALREADY aborted before we started awaiting (re-await),
    // always panic regardless of algebraic effects.
    // Non-effectful futures being aborted is always unexpected, so panic for those too.
    const futureModuleForCheck = extractFutureTraitFromType(futureType);
    const futureEffect = futureModuleForCheck?.isFuture.effect;
    // Resolve through SomeType.resolvedConcreteType so closure-param bundles
    // (where the function.ts post-call sets E.resolvedConcreteType to the
    // annotated bundle struct) are recognized as effectful futures. Without
    // this, the unwind path falls through to the panic branch.
    const effectTypeResolved =
      futureEffect &&
      isSomeType(futureEffect.type) &&
      futureEffect.type.resolvedConcreteType
        ? futureEffect.type.resolvedConcreteType
        : futureEffect?.type;
    const hasAlgebraicEffects =
      effectTypeResolved !== undefined &&
      (isFunctionType(effectTypeResolved) ||
        isSourceNamespaceType(effectTypeResolved) ||
        isStructType(effectTypeResolved));
    if (hasAlgebraicEffects) {
      // Only panic if the future was already aborted before this await
      emitter.emitLine(`${indent}    if (${preAwaitStateVar} == -2) {`);
      emitter.emitLine(
        `${indent}      fprintf(stderr, "panic: attempted to await an aborted Future\\n");`
      );
      emitter.emitLine(`${indent}      abort();`);
      emitter.emitLine(`${indent}    }`);
      // Aborted during this await by effect handler (e.g., Exception.throw escape).
      // The event loop reference was already decremented by the SM itself
      // (emitAsyncFutureEscape for full SM, or sync_fut_t unwind path).
      // Do NOT decrement here — that would cause a double-free/UAF.
      // The pending deferred drops below will handle locally-owned futures;
      // borrowed parameters are not in deferred drops and won't be touched.
      // Drop all in-scope local variables (Path, String, etc.)
      // Exclude the await result variable — it hasn't been declared yet in C.
      const savedDrops = functionContext.pendingDeferredDrops;
      if (savedDrops) {
        const resultVarToSkip = expr.$?.variableName;
        functionContext.pendingDeferredDrops = savedDrops.filter((dropExpr) => {
          const targetVar = getDeferredDropTargetAtomName(dropExpr);
          return targetVar !== resultVarToSkip;
        });
      }
      generatePendingDeferredDrops(indent + "    ", functionContext, expr);
      functionContext.pendingDeferredDrops = savedDrops;
      // Determine if this function is the handler installation point for the
      // effect that caused the escape. If a `given` handler is locally installed
      // (not forwarded via evidence params), the function should extract the
      // unwind value and return it. Otherwise, propagate the escape to the caller.
      const isHandlerInstallation = isAwaitUnwindHandlerInstallation(
        futureModuleForCheck!,
        functionContext
      );
      const returnType = functionContext.currentFunctionType?.return?.type;
      if (isHandlerInstallation) {
        // Handler installation: consume the escape and return the unwind value
        emitter.emitLine(`${indent}    __yo_effect_escaped = 0;`);
        if (returnType && !isUnitType(returnType)) {
          const callerCType = getTypeString(returnType, context);
          if (callerCType !== "void") {
            emitter.emitLine(`${indent}    ${callerCType} _unw_result;`);
            emitter.emitLine(
              `${indent}    memcpy(&_unw_result, __yo_unwind_value, sizeof(${callerCType}));`
            );
            emitter.emitLine(`${indent}    return _unw_result;`);
          } else {
            emitter.emitLine(`${indent}    return;`);
          }
        } else {
          emitter.emitLine(`${indent}    return;`);
        }
      } else {
        // Propagation: re-set the unwind flag so the caller can detect it
        emitter.emitLine(`${indent}    __yo_effect_escaped = 1;`);
        if (returnType && !isUnitType(returnType)) {
          const returnTypeStr = getTypeString(returnType, context);
          emitter.emitLine(`${indent}    return (${returnTypeStr}){0};`);
        } else {
          emitter.emitLine(`${indent}    return;`);
        }
      }
    } else {
      // Non-effectful: any abort is unexpected
      emitter.emitLine(
        `${indent}    fprintf(stderr, "panic: attempted to await an aborted Future\\n");`
      );
      emitter.emitLine(`${indent}    abort();`);
    }
    emitter.emitLine(`${indent}  }`);
    emitter.emitLine(`${indent}}`);

    if (!isResultUnit) {
      const resultVar = expr.$?.variableName || `__sync_await_result`;
      const resultTypeStr = getTypeString(resultType, context);
      const varDecl = getVariableTypeString(resultType, resultVar, context);
      if (hasAlgebraicEffects) {
        // For effectful futures, the state may be -2 (aborted by handler during this await).
        // Declare variable first, then conditionally assign result or zero-init.
        emitter.emitLine(`${indent}${varDecl};`);
        emitter.emitLine(`${indent}if (${syncFutureVar}->state == -1) {`);
        if (typeContainsRcType(resultType)) {
          const dupFn = getDupFunctionForType(resultType, context);
          if (dupFn) {
            emitter.emitLine(
              `${indent}  ${resultVar} = ${dupFn}(${syncFutureVar}->result);`
            );
          } else {
            emitter.emitLine(
              `${indent}  ${resultVar} = ${syncFutureVar}->result;`
            );
          }
        } else {
          emitter.emitLine(
            `${indent}  ${resultVar} = ${syncFutureVar}->result;`
          );
        }
        emitter.emitLine(`${indent}} else {`);
        emitter.emitLine(`${indent}  ${resultVar} = (${resultTypeStr}){0};`);
        emitter.emitLine(`${indent}}`);
      } else {
        // Non-effectful: state is guaranteed to be -1 (completed) since we
        // panicked above on -2 (aborted). Dup for RC types.
        if (typeContainsRcType(resultType)) {
          const dupFn = getDupFunctionForType(resultType, context);
          if (dupFn) {
            emitter.emitLine(
              `${indent}${varDecl} = ${dupFn}(${syncFutureVar}->result);`
            );
          } else {
            emitter.emitLine(`${indent}${varDecl} = ${syncFutureVar}->result;`);
          }
        } else {
          emitter.emitLine(`${indent}${varDecl} = ${syncFutureVar}->result;`);
        }
      }
      return resultVar;
    } else {
      return ``;
    }
  }

  // Outside async context - this is an error
  return `// Error: await should only be used inside async blocks`;
}

/**
 * io.state - read the state of a Future without awaiting it.
 * Returns a FutureState enum value (Pending=0, Running=1, Completed=-1, Aborted=-2).
 *
 * The raw state machine field can be 0 (cold/pending), 1..N (running/intermediate),
 * -1 (completed), or -2 (aborted). Any positive value maps to Running (1).
 */
export function generateState(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const futureArg = expr.args[0];
  if (!futureArg) {
    return `// Error: io.state requires exactly 1 argument`;
  }

  const futureType = futureArg.$?.type;
  if (!futureType || !typeImplementsFuture(futureType)) {
    return `// Error: io.state argument must be a Future type`;
  }

  const functionContext = context as FunctionGenerationContext;
  const emitter = functionContext.emitter;
  const futureCode = generateExpr(futureArg, indent, context);

  // Map raw state machine state to FutureState enum values:
  //   0       → Pending (0)
  //   1..N    → Running (1)
  //  -1       → Completed (-1)
  //  -2       → Aborted (-2)
  const rawVar = expr.$?.variableName
    ? `__raw_state_${expr.$.variableName}`
    : `__raw_state`;
  const resultVar = expr.$?.variableName || `__io_state_result`;

  emitter.emitLine(`${indent}int ${rawVar} = ${futureCode}->state;`);
  emitter.emitLine(
    `${indent}int32_t ${resultVar} = (${rawVar} > 0) ? 1 : ${rawVar};`
  );

  return resultVar;
}

/**
 * JoinHandle.await(using(io)) — await a spawned task, return Option(T).
 *
 * The JoinHandle struct wraps a void* pointer to the spawned future's state machine.
 * All generated futures share a common initial layout:
 *   __yo_ref_header_t header;
 *   int state;
 *   ResultType result;
 *   void (*continuation_fn)(void*);
 *   void* continuation_sm;
 *   void (*__yo_resume_fn)(void*);
 *
 * We cast the void* to a common header struct for the result type T,
 * poll until completion or abort, then return Option(T):
 *   - state == -1 (completed) → .Some(result)
 *   - state == -2 (aborted)   → .None
 */
export function generateJoinHandleAwait(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const functionContext = context as FunctionGenerationContext;
  const emitter = functionContext.emitter;

  // Method call: expr.func is PropertyAccess(handle, "await"), expr.args is [using(io)]
  // The self (JoinHandle) is in expr.func.args[0]
  const handleArg = exprIsFunctionCall(expr.func)
    ? expr.func.args[0]
    : expr.args[0];
  if (!handleArg) {
    return `// Error: JoinHandle.await requires a self argument`;
  }

  const handleCode = generateExpr(handleArg, indent, context);

  // The return type of this call is Option(T)
  const optionType = expr.$?.type;
  if (!optionType || !isEnumType(optionType)) {
    return `// Error: JoinHandle.await return type must be Option(T)`;
  }

  const optionTypeName = getTypeString(optionType, context);

  // Extract T from Option(T): the .Some variant's first field type
  const someVariant = optionType.variants.find((v) => v.name === "Some");
  const resultType = someVariant?.fields?.[0]?.type;
  const isResultUnit = !resultType || isUnitType(resultType);
  const resultTypeName = isResultUnit
    ? "uint8_t"
    : resultType
      ? getTypeString(resultType, context)
      : "uint8_t";

  // Get enum variant tag names
  const someTag = getEnumVariantCName(optionType, "Some", context);
  const noneTag = getEnumVariantCName(optionType, "None", context);

  const uniqueSuffix = expr.$?.variableName || "jh";
  const futVar = `__jh_future_${uniqueSuffix}`;
  const headerVar = `__jh_header_${uniqueSuffix}`;
  const resultVar = expr.$?.variableName || `__jh_result`;

  // Declare a common future header struct for casting
  // This matches the initial layout of all generated future state machines
  const headerStructName = `__yo_jh_header_${uniqueSuffix}`;

  emitter.emitLine(
    `${indent}// JoinHandle.await — poll spawned task, return Option(T)`
  );
  // Declare result variable outside the block so it's accessible after
  const varDecl = getVariableTypeString(optionType, resultVar, context);
  emitter.emitLine(`${indent}${varDecl};`);
  emitter.emitLine(`${indent}{`);
  // Extract the void* future pointer from the JoinHandle struct
  emitter.emitLine(`${indent}  void* ${futVar} = ${handleCode}.__future;`);
  // Define inline struct type matching the common future header layout
  emitter.emitLine(`${indent}  struct ${headerStructName} {`);
  emitter.emitLine(`${indent}    __yo_ref_header_t header;`);
  emitter.emitLine(`${indent}    int state;`);
  emitter.emitLine(`${indent}    ${resultTypeName} result;`);
  emitter.emitLine(`${indent}    void (*continuation_fn)(void*);`);
  emitter.emitLine(`${indent}    void* continuation_sm;`);
  emitter.emitLine(`${indent}    void (*__yo_resume_fn)(void*);`);
  emitter.emitLine(`${indent}  };`);
  emitter.emitLine(
    `${indent}  struct ${headerStructName}* ${headerVar} = (struct ${headerStructName}*)${futVar};`
  );

  // Poll loop: wait until completed (-1) or aborted (-2)
  emitter.emitLine(`${indent}  int __jh_state = ${headerVar}->state;`);
  emitter.emitLine(`${indent}  while (__jh_state != -1 && __jh_state != -2) {`);
  emitter.emitLine(`${indent}    __yo_async_poll_step();`);
  emitter.emitLine(`${indent}    __jh_state = ${headerVar}->state;`);
  emitter.emitLine(`${indent}  }`);

  // Build the Option(T) result
  emitter.emitLine(`${indent}  if (__jh_state == -1) {`);
  // Completed: return .Some(result)
  if (isResultUnit) {
    // Option(unit): .Some variant has no data field
    emitter.emitLine(
      `${indent}    ${resultVar} = (${optionTypeName}){ .tag = ${someTag} };`
    );
  } else {
    // Dup the result if it contains RC types
    if (resultType && typeContainsRcType(resultType)) {
      const dupFn = getDupFunctionForType(resultType, context);
      if (dupFn) {
        emitter.emitLine(
          `${indent}    ${resultVar} = (${optionTypeName}){ .tag = ${someTag}, .data = { .Some = { .value = ${dupFn}(${headerVar}->result) } } };`
        );
      } else {
        emitter.emitLine(
          `${indent}    ${resultVar} = (${optionTypeName}){ .tag = ${someTag}, .data = { .Some = { .value = ${headerVar}->result } } };`
        );
      }
    } else {
      emitter.emitLine(
        `${indent}    ${resultVar} = (${optionTypeName}){ .tag = ${someTag}, .data = { .Some = { .value = ${headerVar}->result } } };`
      );
    }
  }
  emitter.emitLine(`${indent}  } else {`);
  // Aborted: return .None — also reset unwind flag if set
  emitter.emitLine(`${indent}    __yo_effect_escaped = 0;`);
  emitter.emitLine(
    `${indent}    ${resultVar} = (${optionTypeName}){ .tag = ${noneTag} };`
  );
  emitter.emitLine(`${indent}  }`);

  emitter.emitLine(`${indent}}`);

  return resultVar;
}

/**
 * Check if the current function is a handler installation point for an
 * algebraic effect that could cause a Future abort.
 *
 * Returns true if ANY algebraic effect in the future is locally installed
 * (via `given` binding) rather than forwarded from the caller's evidence
 * parameters. When true, the await unwind path should extract the escape
 * value from __yo_unwind_value and return it directly.
 */
function isAwaitUnwindHandlerInstallation(
  futureTraitType: ReturnType<typeof extractFutureTraitFromType> & object,
  context: FunctionGenerationContext
): boolean {
  const effect = futureTraitType.isFuture.effect;
  if (!effect) return false;

  const evidenceParams = context.currentEvidenceParams;

  if (isFunctionType(effect.type)) {
    // Function-type effect (e.g., Raise): key is "label.label"
    const key = `${effect.label}.${effect.label}`;
    if (!evidenceParams?.has(key)) {
      return true; // Not forwarded → locally installed
    }
  } else if (isSourceNamespaceType(effect.type) || isStructType(effect.type)) {
    // Record-type effect (e.g., Exception/Io): check if any member is in evidence
    let isForwarded = false;
    if (evidenceParams) {
      for (const [key] of evidenceParams) {
        if (key.startsWith(`${effect.label}.`)) {
          isForwarded = true;
          break;
        }
      }
    }
    if (!isForwarded) {
      return true; // Not forwarded → locally installed
    }
  }

  return false; // All algebraic effects are forwarded
}

function usesGenericFutureInterface(
  futureType: Type,
  context: CodeGenContext
): boolean {
  if (!isSomeType(futureType) || !typeImplementsFuture(futureType)) {
    return false;
  }
  if (context.types[futureType.id]) {
    return false;
  }
  if (futureType.resolvedConcreteType) {
    if (
      isSomeType(futureType.resolvedConcreteType) &&
      context.types[futureType.resolvedConcreteType.id]
    ) {
      return false;
    }
    if (isStructType(futureType.resolvedConcreteType)) {
      const captureStructId = futureType.resolvedConcreteType.id;
      for (const entry of Object.values(context.types)) {
        if (
          isSomeType(entry.type) &&
          typeImplementsFuture(entry.type) &&
          entry.type.resolvedConcreteType &&
          isStructType(entry.type.resolvedConcreteType) &&
          entry.type.resolvedConcreteType.id === captureStructId
        ) {
          return false;
        }
      }
    }
  }
  return !!extractFutureTraitFromType(futureType);
}

function emitFutureEffectInjectionLine(
  futureType: Type,
  futureVar: string,
  fieldLabel: string,
  memberCode: string,
  indent: string,
  context: FunctionGenerationContext
): void {
  if (usesGenericFutureInterface(futureType, context)) {
    context.emitter.emitLine(
      `${indent}  if (${futureVar}->__yo_set_effect_fn) ${futureVar}->__yo_set_effect_fn((void*)${futureVar}, ${quoteCString(fieldLabel)}, (void*)${memberCode});`
    );
    return;
  }
  context.emitter.emitLine(
    `${indent}  ${futureVar}->__capture.${fieldLabel} = (void*)${memberCode};`
  );
}

/**
 * Generate effect injection code for io.await call sites.
 */
/**
 * Inject the effect bundle from `io.spawn(future, bundle)` / similar callers
 * into the future's SM via the set_effect callback. Exported variant of the
 * struct-bundle path of `emitEffectInjectionForAwait`. Caller passes the
 * bundle as `expr.args[1]`.
 */
export function emitIoSpawnEffectInjection(
  expr: FnCallExpr,
  futureVar: string,
  indent: string,
  context: CodeGenContext
): void {
  const futureArg = expr.args[0];
  if (!futureArg?.$?.type) return;
  const futureTraitType = extractFutureTraitFromType(futureArg.$.type);
  const effect = futureTraitType?.isFuture.effect;
  if (!effect) return;
  const bundleArg = expr.args[1];
  if (!bundleArg) return;
  const functionContext = context as FunctionGenerationContext;
  const bundleCode = generateExpr(bundleArg, indent, context);
  // Prefer the future's resolved effect type for the cast; fall back to the
  // arg's own type when the effect remains SomeType (closure-param bundles
  // for io.async-shaped closures, where the SM declares a __yo_param_<i>
  // slot via the dedicated "__bundle" set_effect case).
  const castType =
    isSourceNamespaceType(effect.type) || isStructType(effect.type)
      ? effect.type
      : (bundleArg.$?.type ?? effect.type);
  const bundleType = getTypeString(castType, context);
  const tmpName = `__yo_eff_bundle_${effectInjectionTmpCounter++}`;
  functionContext.emitter.emitLine(
    `${indent}${bundleType} ${tmpName} = ${bundleCode};`
  );
  functionContext.emitter.emitLine(
    `${indent}if (${futureVar}->__yo_set_effect_fn) ${futureVar}->__yo_set_effect_fn((void*)${futureVar}, "__bundle", (void*)&${tmpName});`
  );
}

function emitEffectInjectionForAwait(
  expr: FnCallExpr,
  futureVar: string,
  indent: string,
  context: CodeGenContext
): void {
  const futureArg = expr.args[0];
  if (!futureArg?.$?.type) return;

  const futureTraitType = extractFutureTraitFromType(futureArg.$.type);
  const effect = futureTraitType?.isFuture.effect;
  if (!effect) return;

  const functionContext = context as FunctionGenerationContext;

  // Resolve the effect bundle from the surrounding scope. `using(...)` is
  // gone in explicit-effects, so there is no per-call-site arg list to
  // consult.
  if (isFunctionType(effect.type)) {
    const handlerCode = resolveEffectFieldFromScope(
      effect.label,
      functionContext,
      expr
    );
    if (handlerCode) {
      emitFutureEffectInjectionLine(
        futureArg.$.type,
        futureVar,
        effect.label,
        handlerCode,
        indent,
        functionContext
      );
    }
  } else if (isSourceNamespaceType(effect.type) || isStructType(effect.type)) {
    // Whole-bundle injection: io.await/io.spawn pass the user's bundle
    // value as the second positional arg (e.g. `io.await(future, IoExn(...))`).
    // Generate that expression, store it in a local, and hand its address
    // to the future's set_effect("__bundle", &bundle) callback. The
    // matching set_effect impl copies the struct into the SM's bundle
    // field (see findBundleFieldName / generateFutureEffectSetter).
    const bundleArg = expr.args[1];
    if (bundleArg) {
      const bundleCode = generateExpr(bundleArg, indent, context);
      const bundleType = getTypeString(effect.type, context);
      const tmpName = `__yo_eff_bundle_${effectInjectionTmpCounter++}`;
      functionContext.emitter.emitLine(
        `${indent}${bundleType} ${tmpName} = ${bundleCode};`
      );
      functionContext.emitter.emitLine(
        `${indent}if (${futureVar}->__yo_set_effect_fn) ${futureVar}->__yo_set_effect_fn((void*)${futureVar}, "__bundle", (void*)&${tmpName});`
      );
      return;
    }
    emitEffectRecordInjection(
      effect.type,
      futureArg.$.type,
      futureVar,
      indent,
      undefined,
      functionContext,
      expr
    );
  } else {
    // Closure-param bundle injection: when the future's effect type is still
    // a SomeType (unbound at the future-trait level) but the user supplied a
    // bundle value as args[1], inject it via set_effect("__bundle", ...).
    // The receiving sync future SM has a dedicated __yo_param_<i> slot for
    // exactly this — see generateIoAsyncSyncCall in async.ts.
    const bundleArg = expr.args[1];
    if (bundleArg?.$?.type) {
      const bundleCode = generateExpr(bundleArg, indent, context);
      const bundleType = getTypeString(bundleArg.$.type, context);
      const tmpName = `__yo_eff_bundle_${effectInjectionTmpCounter++}`;
      functionContext.emitter.emitLine(
        `${indent}${bundleType} ${tmpName} = ${bundleCode};`
      );
      functionContext.emitter.emitLine(
        `${indent}if (${futureVar}->__yo_set_effect_fn) ${futureVar}->__yo_set_effect_fn((void*)${futureVar}, "__bundle", (void*)&${tmpName});`
      );
    }
  }
}

let effectInjectionTmpCounter = 0;

/**
 * Inject struct-record effect fields (e.g., Exception.throw) into a Future's capture struct.
 * Resolves each function field from: using arg value, caller evidence params, SM captures, or given bindings.
 */
function emitEffectRecordInjection(
  sourceNamespaceType: SourceNamespaceType | StructType,
  futureType: Type,
  futureVar: string,
  indent: string,
  usingArgValue: import("../../value").Value | undefined,
  functionContext: FunctionGenerationContext,
  expr: FnCallExpr
): void {
  for (const field of sourceNamespaceType.fields) {
    if (!isFunctionType(field.type)) continue;
    let memberCode: string | undefined;

    // Inside SM: member is captured in state machine variables
    if (functionContext.stateMachineVariables) {
      for (const [, capturedVar] of functionContext.stateMachineVariables) {
        if (capturedVar.name === field.label && capturedVar.kind === "outer") {
          memberCode = `sm->__capture.${field.label}`;
          break;
        }
      }
    }

    // Resolve from explicit using arg's effect record value
    if (!memberCode && usingArgValue && isStructValue(usingArgValue)) {
      const fieldIndex = sourceNamespaceType.fields.indexOf(field);
      const memberValue = usingArgValue.fields[fieldIndex];
      if (memberValue && isFunctionValue(memberValue)) {
        const funcEntry = functionContext.functions[memberValue.funcId];
        if (funcEntry) {
          memberCode = funcEntry.cName;
        }
      }
    }

    // Resolve from caller's evidence params (transitive forwarding)
    if (!memberCode && functionContext.currentEvidenceParams) {
      for (const ep of functionContext.currentEvidenceParams.values()) {
        if (ep.fieldLabel === field.label) {
          memberCode = ep.cParamName;
          break;
        }
      }
    }

    // Resolve from given bindings in the call environment
    if (!memberCode) {
      memberCode = resolveEvidenceFieldFromGivenBindings(
        field.label,
        sourceNamespaceType,
        functionContext,
        expr
      );
    }

    if (memberCode) {
      emitFutureEffectInjectionLine(
        futureType,
        futureVar,
        field.label,
        memberCode,
        indent,
        functionContext
      );
    }
  }
}

/**
 * Resolvean effect record field (e.g., "throw" from Exception) from given bindings in the environment.
 */
function resolveEvidenceFieldFromGivenBindings(
  fieldLabel: string,
  sourceNamespaceType: SourceNamespaceType | StructType,
  functionContext: FunctionGenerationContext,
  expr: FnCallExpr
): string | undefined {
  const callEnv = expr.$?.env ?? expr.func.$?.env;
  if (!callEnv) return undefined;

  const implicitVars = getVariablesFromEnvByFilter(
    callEnv,
    (_v) => true /* removed isImplicit check — Phase 2 */
  );
  // Iterate in reverse to get the innermost (most-recently bound) given binding,
  // since getVariablesFromEnvByFilter returns outermost-first.
  for (let i = implicitVars.length - 1; i >= 0; i--) {
    const v = implicitVars[i]!;
    const val = v.value?.[v.value.length - 1];
    if (val && isStructValue(val)) {
      const fieldIdx = val.type.fields.findIndex((f) => f.label === fieldLabel);
      if (fieldIdx >= 0) {
        const fieldVal = val.fields[fieldIdx];
        if (fieldVal && isFunctionValue(fieldVal)) {
          const cName = functionContext.functions[fieldVal.funcId]?.cName;
          if (cName) return cName;
        }
      }
    }
  }
  return undefined;
}

/**
 * Resolve a function-type effect field from scope (evidence params, SM captures).
 */
function resolveEffectFieldFromScope(
  fieldLabel: string,
  functionContext: FunctionGenerationContext,
  _expr: FnCallExpr
): string | undefined {
  // Check caller's evidence params
  if (functionContext.currentEvidenceParams) {
    for (const ep of functionContext.currentEvidenceParams.values()) {
      if (ep.fieldLabel === fieldLabel) {
        return ep.cParamName;
      }
    }
  }
  // Check SM capture variables
  if (functionContext.stateMachineVariables) {
    for (const [, capturedVar] of functionContext.stateMachineVariables) {
      if (capturedVar.name === fieldLabel && capturedVar.kind === "outer") {
        return `sm->__capture.${fieldLabel}`;
      }
    }
  }
  return undefined;
}
