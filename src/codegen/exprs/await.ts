import { isIoAwaitCall } from "../../evaluator/async/await-analysis";
import {
  extractFutureTraitFromType,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import type { FnCallExpr } from "../../expr";
import { isUnitType } from "../../types/guards";
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
  if (functionContext.inStateMachine) {
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

    emitter.emitLine(
      `${indent}// Synchronous await (io.await outside state machine)`
    );
    emitter.emitLine(
      `${indent}${futureTypeName} __sync_future = ${futureCode};`
    );
    emitter.emitLine(
      `${indent}while (atomic_load_explicit(&__sync_future->state, memory_order_acquire) != -1) {`
    );
    emitter.emitLine(`${indent}  yo_async_run_ready_tasks();`);
    emitter.emitLine(`${indent}}`);

    if (!isUnitType(resultType)) {
      const resultVar = expr.$?.variableName || `__sync_await_result`;
      const varDecl = getVariableTypeString(resultType, resultVar, context);
      emitter.emitLine(`${indent}${varDecl} = __sync_future->result;`);
      // Mark as consumed so dispose won't drop the result, then release the future
      emitter.emitLine(
        `${indent}atomic_store_explicit(&__sync_future->state, -2, memory_order_release);`
      );
      emitter.emitLine(`${indent}__yo_decr_rc(__sync_future);`);
      return resultVar;
    } else {
      // Mark as consumed and release the future
      emitter.emitLine(
        `${indent}atomic_store_explicit(&__sync_future->state, -2, memory_order_release);`
      );
      emitter.emitLine(`${indent}__yo_decr_rc(__sync_future);`);
      return ``;
    }
  }

  // Outside async context - this is an error
  return `// Error: await should only be used inside async blocks`;
}
