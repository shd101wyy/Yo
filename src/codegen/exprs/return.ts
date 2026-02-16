import { getVariablesFromEnv } from "../../env";
import { extractFutureTraitFromType } from "../../evaluator/trait-checking";
import {
  type AtomExpr,
  BuiltinKeywords,
  type Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  type FnCallExpr,
} from "../../expr";
import { isUnitType } from "../../types/guards";
import type { FunctionGenerationContext } from "../functions/context";
import {
  type CodeGenContext,
  getDeferredDropTargetAtomName,
  getTypeString,
  getVariableNameForCodegen,
  sanitizeForCIdentifier,
} from "../utils";
import { emitAsyncFutureCompletion } from "./async-completion";
import { generateAtom } from "./atom";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
} from "./drop-dup";
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

import type { EffectStateMachineInfo } from "../effects/effect-state-machine";

/**
 * Generate C code for `return(value)` inside a ctl handler body.
 * This resumes the continuation by setting the SM's resume_value and calling the resume function.
 */
function generateReturnAsResume(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext,
  resumeInfo: { smVar: string; smInfo: EffectStateMachineInfo }
): string {
  const { smVar, smInfo } = resumeInfo;
  const emitter = context.emitter;

  const arg = expr.args[0];
  if (arg) {
    const argCode = generateExpr(arg, indent, context);
    emitter.emitLine(`${indent}${smVar}.resume_value = ${argCode};`);
  }
  emitter.emitLine(`${indent}${smInfo.resumeFunctionName}(&${smVar});`);

  return "";
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
  const functionContext = context as FunctionGenerationContext;

  // Check if we're inside a ctl handler body (return = resume continuation)
  if (functionContext.continuationVariables) {
    const resumeInfo = functionContext.continuationVariables.get("resume");
    if (resumeInfo) {
      return generateReturnAsResume(expr, indent, context, resumeInfo);
    }
  }

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

      // Compute the result value if not unit
      let resultCode: string | undefined;
      if (!isUnitResult) {
        const resultValue =
          expr.$.variableName && needsTempVarDeclaration
            ? expr.$.variableName
            : expr.$.variableName || argCode;
        resultCode = resultValue;
      }

      emitAsyncFutureCompletion({
        emitter: context.emitter,
        indent,
        resultCode,
        debugLabel: context.currentFunctionName,
      });
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

    // Check if we're in a state machine - if so, complete the Future instead of returning
    if (functionContext.inStateMachine) {
      const futureType = functionContext.inStateMachine.futureType;
      const futureModuleType = extractFutureTraitFromType(futureType)!;
      const childType = futureModuleType.isFuture.outputType;
      const isUnitResult = isUnitType(childType);

      generatePendingDeferredDrops(indent, functionContext, expr, true);

      context.emitter.emitLine(
        `${indent}// Final state - complete the result Future (early unit return)`
      );

      const resultCode = !isUnitResult
        ? `(${getTypeString(childType, context)}){0}`
        : undefined;

      emitAsyncFutureCompletion({
        emitter: context.emitter,
        indent,
        resultCode,
        debugLabel: context.currentFunctionName,
      });
      return ``;
    }

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
