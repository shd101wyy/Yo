import { isIoAwaitCall } from "../../evaluator/async/await-analysis";
import {
  extractFutureTraitFromType,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import type { FnCallExpr } from "../../expr";
import { isSomeType, isUnitType } from "../../types/guards";
import type { FunctionGenerationContext } from "../functions/context";
import {
  getTypeString,
  getVariableTypeString,
  type CodeGenContext,
} from "../utils";
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
    // Start cold future if needed (lazy execution: state==0 means not started)
    emitter.emitLine(
      `${indent}if (atomic_load_explicit(&${syncFutureVar}->state, memory_order_acquire) == 0 && ${syncFutureVar}->__yo_resume_fn) {`
    );
    emitter.emitLine(
      `${indent}  __yo_incr_rc((void*)${syncFutureVar});  // event loop reference`
    );
    emitter.emitLine(
      `${indent}  ${syncFutureVar}->__yo_resume_fn((void*)${syncFutureVar});`
    );
    emitter.emitLine(`${indent}}`);
    emitter.emitLine(
      `${indent}while (atomic_load_explicit(&${syncFutureVar}->state, memory_order_acquire) != -1) {`
    );
    emitter.emitLine(`${indent}  yo_async_run_ready_tasks();`);
    emitter.emitLine(`${indent}}`);

    if (!isResultUnit) {
      const resultVar = expr.$?.variableName || `__sync_await_result`;
      const varDecl = getVariableTypeString(resultType, resultVar, context);
      emitter.emitLine(`${indent}${varDecl} = ${syncFutureVar}->result;`);
      // Mark as consumed so dispose won't drop the result when the future
      // variable's scope-exit drop frees the state machine.
      emitter.emitLine(
        `${indent}atomic_store_explicit(&${syncFutureVar}->state, -2, memory_order_release);`
      );
      return resultVar;
    } else {
      // Mark as consumed; scope-exit drop handles SM cleanup.
      emitter.emitLine(
        `${indent}atomic_store_explicit(&${syncFutureVar}->state, -2, memory_order_release);`
      );
      return ``;
    }
  }

  // Outside async context - this is an error
  return `// Error: await should only be used inside async blocks`;
}
