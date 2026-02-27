import { isIoAwaitCall } from "../../evaluator/async/await-analysis";
import {
  extractFutureTraitFromType,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import type { FunctionImplicitParameter } from "../../types/definitions";
import {
  isEffectsRowType,
  isFunctionType,
  isSomeType,
  isUnitType,
} from "../../types/guards";
import { typeContainsRcType } from "../../types/utils";
import { isIoFutureType } from "../async/state-machine";
import type { FunctionGenerationContext } from "../functions/context";
import {
  getTypeString,
  getVariableTypeString,
  type CodeGenContext,
} from "../utils";
import { getDupFunctionForType } from "./drop-dup";
import { generateExpr } from "./expr";

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

  // Extract the Future module type to get the result type
  const futureModuleType = extractFutureTraitFromType(futureType);
  if (!futureModuleType) {
    return `// Error: could not extract Future module from type`;
  }

  // In async context (state machine), await expressions don't generate code
  // The result is extracted at the start of the next state
  // If this await expression is assigned to a variable, that variable's name is in expr.$.variableName
  const functionContext = context as FunctionGenerationContext;
  if (
    functionContext.inAsyncStateMachine ||
    functionContext.inEffectStateMachine
  ) {
    // Return empty string - the actual await logic is handled by state machine generator
    // The result will be available in the target variable in the next state
    return ``;
  }

  // For io.await outside a state machine, generate synchronous blocking wait
  if (isIoAwaitCall(expr)) {
    const futureCode = generateExpr(futureArg, indent, context);
    const futureTypeName = getTypeString(futureType, context);
    const resultType = futureModuleType.isFuture.outputType;
    const emitter = functionContext.emitter;

    // When the output type is an unresolved SomeType (e.g., from forall(T) in
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
    // Only cold-start state machine futures; IO futures are already submitted to io_uring
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
    emitter.emitLine(`${indent}    yo_async_poll_step();`);
    emitter.emitLine(`${indent}    __await_state = ${syncFutureVar}->state;`);
    emitter.emitLine(`${indent}  }`);
    emitter.emitLine(`${indent}  if (__await_state == -2) {`);
    // Check if the Future type includes algebraic effect types (e.g., Future(i32, IO, Raise)).
    // Effectful futures may be intentionally aborted by a ctl handler (e.g., raise + abort)
    // during the CURRENT await — don't panic for that case.
    // But if the future was ALREADY aborted before we started awaiting (re-await),
    // always panic regardless of algebraic effects.
    // Non-effectful futures being aborted is always unexpected, so panic for those too.
    const futureModuleForCheck = extractFutureTraitFromType(futureType);
    const hasAlgebraicEffects =
      futureModuleForCheck?.isFuture.effects?.some(
        (e) => isFunctionType(e.type) || e.isEffectRowSpread
      ) ?? false;
    if (hasAlgebraicEffects) {
      // Only panic if the future was already aborted before this await
      emitter.emitLine(`${indent}    if (${preAwaitStateVar} == -2) {`);
      emitter.emitLine(
        `${indent}      fprintf(stderr, "panic: attempted to await an aborted Future\\n");`
      );
      emitter.emitLine(`${indent}      abort();`);
      emitter.emitLine(`${indent}    }`);
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
 * Expand effect row spreads into individual implicit parameters.
 */
function expandFutureEffects(
  effects: FunctionImplicitParameter[]
): FunctionImplicitParameter[] {
  const result: FunctionImplicitParameter[] = [];
  for (const effect of effects) {
    if (effect.isEffectRowSpread) {
      let effectsRow = effect.type;
      if (isSomeType(effectsRow) && effectsRow.resolvedConcreteType) {
        effectsRow = effectsRow.resolvedConcreteType;
      }
      if (isEffectsRowType(effectsRow)) {
        result.push(...effectsRow.implicitParameters);
      }
    } else {
      result.push(effect);
    }
  }
  return result;
}

/**
 * Generate effect injection code for io.await call sites.
 */
function emitEffectInjectionForAwait(
  expr: FnCallExpr,
  futureVar: string,
  indent: string,
  context: CodeGenContext
): void {
  const futureArg = expr.args[0];
  if (!futureArg?.$?.type) return;

  const usingExpr = expr.args.find(
    (arg): arg is FnCallExpr =>
      exprIsFunctionCall(arg) &&
      exprIsFunctionCallOf(arg, BuiltinKeywords.using)
  );
  if (!usingExpr) return;

  const futureTraitType = extractFutureTraitFromType(futureArg.$.type);
  if (!futureTraitType?.isFuture.effects?.length) return;

  const expandedEffects = expandFutureEffects(futureTraitType.isFuture.effects);
  const usingArgs = usingExpr.args;
  const functionContext = context as FunctionGenerationContext;
  const emitter = functionContext.emitter;

  for (let i = 0; i < expandedEffects.length && i < usingArgs.length; i++) {
    const effect = expandedEffects[i]!;
    const usingArg = usingArgs[i]!;

    if (!isFunctionType(effect.type)) continue;
    // Skip generic function effects (forall) — they are compile-time only
    // and don't have a void* field in the capture struct
    if (effect.type.forallParameters.length > 0) continue;

    const handlerCode = generateExpr(usingArg, indent, context);
    const fieldName = effect.label;
    emitter.emitLine(
      `${indent}  ${futureVar}->__capture.${fieldName} = (void*)${handlerCode};`
    );
  }
}
