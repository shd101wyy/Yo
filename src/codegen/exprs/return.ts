import { getVariablesFromEnv } from "../../env";
import { extractFutureTraitFromType } from "../../evaluator/trait-checking";
import {
  type AtomExpr,
  BuiltinFunctions,
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
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
 * Get the C codegen variable name from a deferred drop expression.
 * Used to match pending drops against SM-consumed arg C names.
 */
function getDeferredDropTargetCName(dropExpr: Expr): string | undefined {
  // ___drop(varName) form
  if (
    exprIsFunctionCall(dropExpr) &&
    exprIsFunctionCallOf(dropExpr, BuiltinFunctions.___drop) &&
    dropExpr.args.length >= 1
  ) {
    const firstArg = dropExpr.args[0];
    if (firstArg && exprIsAtom(firstArg)) {
      return getVariableNameForCodegen(firstArg.token.value, firstArg.$?.env);
    }
  }
  // varName.drop() form (method call syntax)
  if (
    exprIsFunctionCall(dropExpr) &&
    dropExpr.args.length === 0 &&
    exprIsFunctionCall(dropExpr.func) &&
    exprIsFunctionCallOf(dropExpr.func, ".", 2) &&
    exprIsAtom(dropExpr.func.args[1]!) &&
    dropExpr.func.args[1]!.token.value === BuiltinFunctions.___drop[0] &&
    exprIsAtom(dropExpr.func.args[0]!)
  ) {
    const atom = dropExpr.func.args[0]!;
    return getVariableNameForCodegen(atom.token.value, atom.$?.env);
  }
  return undefined;
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
export function generatePendingDeferredDrops(
  indent: string,
  context: FunctionGenerationContext,
  expr: Expr,
  isCompletion: boolean = false,
  skipAlreadyDroppedCheck: boolean = false,
  skipEnvCheck: boolean = false
): void {
  if (context.pendingDeferredDrops && context.pendingDeferredDrops.length > 0) {
    // Filter drops to only include variables that exist in the return expression's environment.
    // Variables declared after the return point won't be in expr.$.env yet.
    // Also exclude variables that were already dropped by the expression's own deferredDropExpressions,
    // UNLESS skipAlreadyDroppedCheck is true (used for direct ctl returns where the goto
    // skips the scope-exit drops that would normally run after the expression).
    //
    // When skipEnvCheck is true (e.g., for escape inside inlined handler bodies),
    // we skip the environment check entirely because the escape expression's env
    // is from the handler's scope, not the enclosing function's scope.
    const alreadyDroppedVars = new Set<string>();
    if (!skipAlreadyDroppedCheck && expr.$?.deferredDropExpressions) {
      for (const dropExpr of expr.$.deferredDropExpressions) {
        const varName = getDeferredDropTargetAtomName(dropExpr);
        if (varName) {
          alreadyDroppedVars.add(varName);
        }
      }
    }

    // SM-consumed arg C names: for escape handlers, some pending drop targets
    // have their ownership transferred to the SM. The handler param drops already
    // free them, so we must skip them here to avoid double-free.
    const consumedArgCNames = context.effectSmConsumedArgCNames;

    const dropsToEmit =
      expr.$?.env && !skipEnvCheck
        ? context.pendingDeferredDrops.filter((dropExpr) => {
            const varName = getDeferredDropTargetAtomName(dropExpr);
            if (!varName) return false;
            if (alreadyDroppedVars.has(varName)) return false;
            const variables = getVariablesFromEnv(expr.$!.env, varName);
            return variables.length > 0;
          })
        : context.pendingDeferredDrops.filter((dropExpr) => {
            const varName = getDeferredDropTargetAtomName(dropExpr);
            if (!varName) return false;
            if (alreadyDroppedVars.has(varName)) return false;
            if (consumedArgCNames && consumedArgCNames.size > 0) {
              const cName = getDeferredDropTargetCName(dropExpr);
              if (cName && consumedArgCNames.has(cName)) return false;
            }
            return true;
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
  resumeInfo: {
    smVar: string;
    smInfo: EffectStateMachineInfo;
    effectIndex?: number;
  }
): string {
  const { smVar, smInfo, effectIndex } = resumeInfo;
  const emitter = context.emitter;
  const functionContext = context as FunctionGenerationContext;

  const arg = expr.args[0];
  // Determine the resume_value field name based on effect index
  const resumeField =
    effectIndex !== undefined &&
    smInfo.effectInfos &&
    smInfo.effectInfos.length > 1
      ? `resume_value_${effectIndex}`
      : `resume_value`;
  const resumeTypeCName =
    effectIndex !== undefined &&
    smInfo.effectInfos &&
    smInfo.effectInfos.length > 1
      ? smInfo.effectInfos[effectIndex]!.resumeTypeCName
      : smInfo.resumeTypeCName;

  if (arg && resumeTypeCName !== "void") {
    const argCode = generateExpr(arg, indent, context);
    emitter.emitLine(`${indent}${smVar}.${resumeField} = ${argCode};`);
  }

  // Drop handler parameters BEFORE resuming the state machine.
  // The SM may free yielded data during resume, so params extracted from
  // yield fields must be dropped first to avoid use-after-free.
  if (functionContext.effectHandlerParamDrops) {
    for (const dropCode of functionContext.effectHandlerParamDrops) {
      emitter.emitLine(`${indent}${dropCode};`);
    }
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
      if ("directReturnVar" in resumeInfo) {
        // Direct ctl call (no state machine): assign the return value to the
        // captured temp variable so the call site can use it as an expression.
        // For unit-returning handlers, skip the assignment entirely.
        if (!resumeInfo.isUnitReturn) {
          const arg = expr.args[0];
          if (arg) {
            const argCode = generateExpr(arg, indent, context);
            if (argCode) {
              context.emitter.emitLine(
                `${indent}${resumeInfo.directReturnVar} = ${argCode};`
              );
            }
          }
        }
        // Emit pending deferred drops before the goto. For direct ctl returns,
        // we skip the alreadyDroppedVars exclusion because the goto will jump
        // past the scope-exit drops that would normally run — so those drops
        // MUST be emitted here from pendingDeferredDrops instead.
        // We do NOT emit deferredDropExpressions because those may include drops
        // for the caller's variables (e.g. ctl call arguments) that are borrowed
        // by the handler, not owned.
        generatePendingDeferredDrops(
          indent,
          functionContext,
          expr,
          false,
          true
        );
        // Goto exit label to skip any remaining handler code after `return`
        if (resumeInfo.directExitLabel) {
          context.emitter.emitLine(
            `${indent}goto ${resumeInfo.directExitLabel};`
          );
        }
        return "";
      }
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

    if (
      (functionContext.inAsyncStateMachine ||
        functionContext.inEffectStateMachine) &&
      arg.$?.variableName
    ) {
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

    // Check if we're in a state machine - if so, complete the SM instead of returning
    if (
      functionContext.inAsyncStateMachine ||
      functionContext.inEffectStateMachine
    ) {
      if (functionContext.inEffectStateMachine) {
        // Effect state machine return - set result and mark completed
        generatePendingDeferredDrops(indent, functionContext, expr, true);
        const returnValue = handledDeferredDup
          ? argCode
          : (returnTempVar ?? argCode);
        if (!isUnitType(expr.$.type)) {
          context.emitter.emitLine(`${indent}sm->result = ${returnValue};`);
        }
        context.emitter.emitLine(`${indent}sm->completed = 1;`);
        return `return`;
      }

      // Async state machine return - complete the Future and clean up
      const futureType = functionContext.inAsyncStateMachine!.futureType;
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

    // Check if we're in a state machine - if so, complete the SM instead of returning
    if (
      functionContext.inAsyncStateMachine ||
      functionContext.inEffectStateMachine
    ) {
      if (functionContext.inEffectStateMachine) {
        // Effect state machine unit return - mark completed
        generatePendingDeferredDrops(indent, functionContext, expr, true);
        context.emitter.emitLine(`${indent}sm->completed = 1;`);
        return `return`;
      }

      const futureType = functionContext.inAsyncStateMachine!.futureType;
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
