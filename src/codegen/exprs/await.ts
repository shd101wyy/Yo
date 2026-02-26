import { isIoAwaitCall } from "../../evaluator/async/await-analysis";
import {
  extractFutureTraitFromType,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import type { FnCallExpr } from "../../expr";
import { isSomeType, isUnitType } from "../../types/guards";
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

    emitter.emitLine(
      `${indent}// Synchronous await (io.await outside state machine)`
    );
    emitter.emitLine(
      `${indent}${futureTypeName} ${syncFutureVar} = ${futureCode};`
    );
    // Only cold-start state machine futures; IO futures are already submitted to io_uring
    const isIoFuture = isIoFutureType(futureArg.$?.type);
    if (!isIoFuture) {
      emitter.emitLine(
        `${indent}if (${syncFutureVar}->state == 0 && ${syncFutureVar}->__yo_resume_fn) {`
      );
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
    // An aborted future means an effect handler called abort() during execution.
    // Always panic — if the caller intended to handle effects, they should have
    // provided handlers via using() which would catch the abort before it completes.
    // Re-awaiting an already-aborted future is always an error.
    emitter.emitLine(
      `${indent}    fprintf(stderr, "panic: attempted to await an aborted Future\\n");`
    );
    emitter.emitLine(`${indent}    abort();`);
    emitter.emitLine(`${indent}  }`);
    emitter.emitLine(`${indent}}`);

    if (!isResultUnit) {
      const resultVar = expr.$?.variableName || `__sync_await_result`;
      const varDecl = getVariableTypeString(resultType, resultVar, context);
      // At this point state is guaranteed to be -1 (completed) since we
      // panicked above on -2 (aborted). Dup for RC types so the Future
      // retains its copy for future awaits.
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
