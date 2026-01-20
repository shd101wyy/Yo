import { getVariablesFromEnv } from "../../env";
import {
  AtomExpr,
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  FnCallExpr,
} from "../../expr";
import { extractFutureTraitFromType, isUnitType } from "../../types";
import { FunctionGenerationContext } from "../functions/context";
import {
  CodeGenContext,
  getDeferredDropTargetAtomName,
  getTypeString,
  getVariableNameForCodegen,
  sanitizeForCIdentifier,
} from "../utils";
import { generateAtom } from "./atom";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
} from "./drop_dup";
import { generateExpr } from "./expr";

/**
 * Helper: Handle deferred dup expressions for an atom and return the final code
 */
function handleAtomDeferredDup(
  expr: AtomExpr,
  atomCode: string,
  indent: string,
  context: FunctionGenerationContext
): string {
  if (
    expr.$?.deferredDupExpressions &&
    expr.$.deferredDupExpressions.length > 0
  ) {
    generateDeferredDupExpressions(expr, indent, context);
    const dupExpr = expr.$.deferredDupExpressions[0]!;
    if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
      return getVariableNameForCodegen(dupExpr.$.variableName, dupExpr.$.env);
    }
  }
  return atomCode;
}

/**
 * Helper: Handle deferred dup expressions for a function call and return the final code
 */
function handleFuncCallDeferredDup(
  expr: FnCallExpr,
  indent: string,
  context: FunctionGenerationContext
): string {
  if (
    expr.$?.deferredDupExpressions &&
    expr.$.deferredDupExpressions.length > 0
  ) {
    // Declare temp variable if needed
    if (expr.$?.variableName) {
      const savedVariableName = expr.$.variableName;
      expr.$.variableName = undefined;
      const rawCode = generateExpr(expr, indent, context);
      expr.$.variableName = savedVariableName;

      const exprType = getTypeString(expr.$.type!, context);
      const exprTempVar = sanitizeForCIdentifier(savedVariableName);
      if (exprTempVar !== rawCode) {
        context.emitter.emitLine(
          `${indent}${exprType} ${exprTempVar} = ${rawCode};`
        );
      }
    } else {
      const rawCode = generateExpr(expr, indent, context);
      context.emitter.emitLine(`${indent}${rawCode};`);
    }

    generateDeferredDupExpressions(expr, indent, context);

    const dupExpr = expr.$.deferredDupExpressions[0]!;
    if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
      return getVariableNameForCodegen(dupExpr.$.variableName, dupExpr.$.env);
    }
  }
  return generateExpr(expr, indent, context);
}

/**
 * Helper: Generate pending deferred drops from enclosing begin blocks.
 * Only drops variables that have been declared before the early return.
 * Variables that would be declared after the return point are filtered out
 * by checking if they exist in the return expression's environment.
 *
 * This function should be called AFTER the expression's own deferredDropExpressions
 * have been emitted, to drop variables from enclosing scopes.
 */
function generatePendingDeferredDrops(
  indent: string,
  context: FunctionGenerationContext,
  expr: Expr,
  isCompletion: boolean = false
): void {
  if (context.pendingDeferredDrops && context.pendingDeferredDrops.length > 0) {
    // Filter drops to only include variables that exist in the return expression's environment.
    // Variables declared after the return point won't be in expr.$.env yet.
    // Also exclude variables that were already dropped by the expression's own deferredDropExpressions.
    const alreadyDroppedVars = new Set<string>();
    if (expr.$?.deferredDropExpressions) {
      for (const dropExpr of expr.$.deferredDropExpressions) {
        const varName = getDeferredDropTargetAtomName(dropExpr);
        if (varName) {
          alreadyDroppedVars.add(varName);
        }
      }
    }

    const dropsToEmit = expr.$?.env
      ? context.pendingDeferredDrops.filter((dropExpr) => {
          const varName = getDeferredDropTargetAtomName(dropExpr);
          if (!varName) return false;
          // Skip if already dropped by the expression's own drops
          if (alreadyDroppedVars.has(varName)) return false;
          // Check if the variable exists in the environment at the return point
          const variables = getVariablesFromEnv(expr.$!.env, varName);
          return variables.length > 0;
        })
      : context.pendingDeferredDrops.filter((dropExpr) => {
          const varName = getDeferredDropTargetAtomName(dropExpr);
          if (!varName) return false;
          // Skip if already dropped by the expression's own drops
          return !alreadyDroppedVars.has(varName);
        });

    if (dropsToEmit.length > 0) {
      const message = isCompletion
        ? "Drop local variables before early completion"
        : "Drop local variables before early return";
      context.emitter.emitLine(`${indent}// ${message}`);
      for (const dropExpr of dropsToEmit) {
        const dropCode = generateExpr(dropExpr, indent, context);
        if (dropCode) {
          context.emitter.emitLine(`${indent}${dropCode};`);
        }
      }
    }
  }
}

/**
 * Generate a return statement for `return` expressions
 * Function with explicit return:
 *   bar :: (fn() -> i32) { return(42); }
 */
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

      generatePendingDeferredDrops(indent, functionContext, expr, true);

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
    generatePendingDeferredDrops(indent, functionContext, expr);

    if (isUnitType(expr.$.type)) {
      return `return`;
    }

    const returnValue = handledDeferredDup
      ? argCode
      : (returnTempVar ?? argCode);
    return `return ${returnValue}`;
  } else {
    // Unit return (no argument)
    if (expr.$?.deferredDropExpressions) {
      generateDeferredDropExpressions(expr, indent, context);
    }

    const functionContext = context as FunctionGenerationContext;
    generatePendingDeferredDrops(indent, functionContext, expr);

    return "return";
  }
}

/**
 * Generate a return statement for implicit function body return
 * Example: foo :: (fn() -> i32)(42)
 */
export function generateImplicitReturnStatement(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  const functionContext = context as FunctionGenerationContext;

  switch (expr.tag) {
    case ExprTag.Atom: {
      const atomCode = generateAtom(expr, context);
      const finalCode = handleAtomDeferredDup(
        expr,
        atomCode,
        indent,
        functionContext
      );
      context.emitter.emitLine(`${indent}return ${finalCode};`);
      break;
    }

    case ExprTag.FnCall: {
      // Special case: explicit return call should not be wrapped in another return
      if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
        const funcCallCode = generateExpr(expr, indent, context);
        context.emitter.emitLine(`${indent}${funcCallCode};`);
      } else {
        const finalCode = handleFuncCallDeferredDup(
          expr,
          indent,
          functionContext
        );
        context.emitter.emitLine(`${indent}return ${finalCode};`);
      }
      break;
    }
  }
}
