import { exprIsFunctionCall, FnCallExpr } from "../../expr";
import { extractFutureTraitFromType, isUnitType } from "../../types";
import { FunctionGenerationContext } from "../functions/context";
import {
  CodeGenContext,
  getTypeString,
  getVariableNameForCodegen,
} from "../utils";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
} from "./drop_dup";
import { generateExpr } from "./expr";

export function generateReturn(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const arg = expr.args[0];
  if (arg) {
    if (!expr.$) {
      throw new Error(`Internal error: return expression missing metadata`);
    }
    // For non-unit types, we need a temporary variable to hold the return value
    // before deferred drop expressions run
    if (!expr.$.variableName && !isUnitType(expr.$.type)) {
      return `// Error: return expression missing temporary variable name`;
    }

    // Special handling for async functions: we need to get the raw value code
    // without temp variable indirection to properly declare the temp variable
    const functionContext = context as FunctionGenerationContext;
    let argCode: string;
    let needsTempVarDeclaration = false;

    if (functionContext.inStateMachine && arg.$?.variableName) {
      // In async context: generate raw value code by temporarily clearing variableName
      const savedVariableName = arg.$.variableName;
      arg.$.variableName = undefined;
      argCode = generateExpr(arg, indent, context);
      arg.$.variableName = savedVariableName;
      needsTempVarDeclaration = true;
    } else {
      // Check if arg has both a variableName and deferredDupExpressions
      // This happens when we need to store the arg value in a temp var before duping it
      if (
        arg.$?.variableName &&
        arg.$?.deferredDupExpressions &&
        arg.$.deferredDupExpressions.length > 0
      ) {
        // Generate the arg value without the variableName to get the raw expression
        const savedVariableName = arg.$.variableName;
        arg.$.variableName = undefined;
        const rawArgCode = generateExpr(arg, indent, context);
        arg.$.variableName = savedVariableName;

        // Declare and assign the temp variable
        const argType = getTypeString(arg.$.type!, context);
        const argTempVar = getVariableNameForCodegen(
          savedVariableName,
          arg.$.env
        );

        if (argTempVar !== rawArgCode) {
          context.emitter.emitLine(
            `${indent}${argType} ${argTempVar} = ${rawArgCode};`
          );
        }
        argCode = argTempVar;
      } else {
        argCode = generateExpr(arg, indent, context);
      }
    }

    // Handle deferred dup expressions for the return argument.
    // This is needed when returning a borrowed parameter - we must call dup
    // to increment the reference count since return values are owned.
    let handledDeferredDup = false;
    if (
      arg.$?.deferredDupExpressions &&
      arg.$.deferredDupExpressions.length > 0
    ) {
      generateDeferredDupExpressions(arg, indent, functionContext);
      const dupExpr = arg.$.deferredDupExpressions[0]!;
      if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
        argCode = getVariableNameForCodegen(
          dupExpr.$.variableName,
          dupExpr.$.env
        );
        handledDeferredDup = true;
      }
    }

    const returnType = getTypeString(expr.$.type!, context);

    // The evaluator provides a temp variable name for return expressions so we can
    // compute the value before running deferred drops.
    const returnTempVar = expr.$.variableName
      ? getVariableNameForCodegen(expr.$.variableName, expr.$.env)
      : undefined;

    // Skip re-declaring if we already generated a dup call with a temp variable
    // Also skip if the variable name is the same as the arg code (e.g., returning a local variable)
    if (
      !handledDeferredDup &&
      !isUnitType(expr.$.type) &&
      returnTempVar &&
      returnTempVar !== argCode // Prevent something like: int32_t counter = counter;
    ) {
      context.emitter.emitLine(
        `${indent}${returnType} ${returnTempVar} = ${argCode};`
      );
    }

    if (expr.$.deferredDropExpressions) {
      generateDeferredDropExpressions(expr, indent, context);
    }

    // Check if we're in a state machine - if so, complete the Future instead of returning
    if (functionContext.inStateMachine) {
      // State machine return - complete the Future and clean up
      const futureType = functionContext.inStateMachine.futureType;
      const futureModuleType = extractFutureTraitFromType(futureType)!;
      const childType = futureModuleType.isFuture.outputType;
      const isUnitResult = isUnitType(childType);

      // Generate pending deferred drops from enclosing begin blocks
      // This is needed when returning early from inside a cond branch - the outer
      // begin block's deferred drops would otherwise be skipped.
      // Only generate these if the return expression doesn't already have its own
      // deferred drops (to avoid double-dropping).
      if (
        functionContext.pendingDeferredDrops &&
        (!expr.$.deferredDropExpressions ||
          expr.$.deferredDropExpressions.length === 0)
      ) {
        context.emitter.emitLine(
          `${indent}// Drop local variables before early completion`
        );
        for (const dropExpr of functionContext.pendingDeferredDrops) {
          const dropCode = generateExpr(dropExpr, indent, context);
          if (dropCode) {
            context.emitter.emitLine(`${indent}${dropCode};`);
          }
        }
      }

      context.emitter.emitLine(
        `${indent}// Final state - complete the result Future`
      );
      context.emitter.emitLine(
        `${indent}ASYNC_DEBUG("${context.currentFunctionName}: Completing async function\\n");`
      );

      // Store the result if not unit
      if (!isUnitResult) {
        // Use argCode directly if we didn't need a temp variable, otherwise use the temp variable
        const resultValue =
          expr.$.variableName && needsTempVarDeclaration
            ? expr.$.variableName
            : expr.$.variableName || argCode;
        context.emitter.emitLine(`${indent}sm->result = ${resultValue};`);
      }

      // Set state to COMPLETED with release semantics
      // This ensures the result write above is visible to other threads
      context.emitter.emitLine(
        `${indent}ASYNC_DEBUG("${context.currentFunctionName}: Setting state to COMPLETED\\n");`
      );
      context.emitter.emitLine(
        `${indent}atomic_store_explicit(&sm->state, -1, memory_order_release);  // -1 = completed`
      );

      // Check if there's a continuation waiting (with acquire semantics to see the continuation registration)
      context.emitter.emitLine(``);
      context.emitter.emitLine(
        `${indent}// Check if there's a continuation waiting for this Future to complete`
      );
      context.emitter.emitLine(
        `${indent}void (*continuation_fn)(void*) = atomic_load_explicit(&sm->continuation_fn, memory_order_acquire);`
      );
      context.emitter.emitLine(
        `${indent}void* continuation_sm = atomic_load_explicit(&sm->continuation_sm, memory_order_acquire);`
      );
      context.emitter.emitLine(`${indent}if (continuation_fn != NULL) {`);
      context.emitter.emitLine(
        `${indent}  ASYNC_DEBUG("${context.currentFunctionName}: Spawning continuation: resume_fn=%p, sm=%p\\n", (void*)continuation_fn, continuation_sm);`
      );
      context.emitter.emitLine(
        `${indent}  yo_async_spawn_task(continuation_fn, continuation_sm);`
      );
      context.emitter.emitLine(`${indent}}`);

      context.emitter.emitLine(
        `${indent}sm->state = ${Number.MAX_SAFE_INTEGER};  // Terminal state`
      );
      context.emitter.emitLine(``);
      context.emitter.emitLine(
        `${indent}// Release the "running task" reference now that task is complete`
      );
      context.emitter.emitLine(
        `${indent}// This balances the __yo_incr_rc in the constructor`
      );
      context.emitter.emitLine(`${indent}__yo_decr_rc((void*)sm);`);
      context.emitter.emitLine(``);
      // Return from the void resume function
      context.emitter.emitLine(`${indent}return;`);
      // Return empty string so no additional code is generated
      return ``;
    }

    // Normal (non-state-machine) return

    // Generate pending deferred drops from enclosing begin blocks
    // This is needed when returning early from inside a cond/match branch - the outer
    // begin block's deferred drops would otherwise be skipped.
    // Only generate these if the return expression doesn't already have its own
    // deferred drops (to avoid double-dropping).
    if (
      functionContext.pendingDeferredDrops &&
      (!expr.$.deferredDropExpressions ||
        expr.$.deferredDropExpressions.length === 0)
    ) {
      context.emitter.emitLine(
        `${indent}// Drop local variables before early return`
      );
      for (const dropExpr of functionContext.pendingDeferredDrops) {
        const dropCode = generateExpr(dropExpr, indent, context);
        if (dropCode) {
          context.emitter.emitLine(`${indent}${dropCode};`);
        }
      }
    }

    if (isUnitType(expr.$.type)) {
      return `return`;
    }

    // If we handled deferred dup, use argCode (which is the dup result temp variable)
    // Otherwise use expr.$.variableName as before
    const returnValue = handledDeferredDup
      ? argCode
      : (returnTempVar ?? argCode);
    return `return ${returnValue}`;
  } else {
    if (expr.$?.deferredDropExpressions) {
      generateDeferredDropExpressions(expr, indent, context);
    }

    const functionContext = context as FunctionGenerationContext;

    // Generate pending deferred drops for unit return as well
    if (functionContext.pendingDeferredDrops) {
      context.emitter.emitLine(
        `${indent}// Drop local variables before early return`
      );
      for (const dropExpr of functionContext.pendingDeferredDrops) {
        const dropCode = generateExpr(dropExpr, indent, context);
        if (dropCode) {
          context.emitter.emitLine(`${indent}${dropCode};`);
        }
      }
    }

    return "return";
  }
}
