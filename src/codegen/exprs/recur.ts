import { exprIsFunctionCall, exprToString, type FnCallExpr } from "../../expr";
import type { FunctionGenerationContext } from "../functions/context";
import { isUnitType } from "../../types/guards";
import {
  type CodeGenContext,
  getTypeString,
  getVariableNameForCodegen,
} from "../utils";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
} from "./drop-dup";
import { generateExpr } from "./expr";

/**
 * The `recur` function call,
 * generating a recursive function call.
 */
export function generateRecur(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
  if (runtimeArgExprs) {
    const functionContext = context as FunctionGenerationContext;

    // Generate recur call with arguments and dup handling
    const argsList = runtimeArgExprs
      .map((arg) => {
        const argCode = generateExpr(arg, indent, context);

        // Handle deferred dup expressions for recur arguments
        if (
          arg.$?.deferredDupExpressions &&
          arg.$.deferredDupExpressions.length > 0
        ) {
          generateDeferredDupExpressions(arg, indent, functionContext);
          // Use the dup result variable instead of the original
          const dupExpr = arg.$.deferredDupExpressions[0]!;
          if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
            return getVariableNameForCodegen(
              dupExpr.$.variableName,
              dupExpr.$.env
            );
          }
        }

        return argCode;
      })
      .join(", ");
    // Append evidence parameters (using() / algebraic effect function pointers).
    // Since recur is a self-call, the callee's evidence params are the same as
    // the current function's — they must be forwarded to the recursive call.
    const evidenceArgs: string[] = [];
    if (functionContext.currentEvidenceParams?.size) {
      for (const ep of functionContext.currentEvidenceParams.values()) {
        evidenceArgs.push(ep.cParamName);
      }
    }

    const fullArgs =
      argsList && evidenceArgs.length > 0
        ? `${argsList}, ${evidenceArgs.join(", ")}`
        : argsList || evidenceArgs.join(", ");

    const callCode = `${context.currentFunctionName}(${fullArgs})`;

    // Handle deferred drop expressions at the expression level (e.g., from
    // moves of RC-typed arguments into the recursive call).
    if (expr.$?.deferredDropExpressions) {
      generateDeferredDropExpressions(expr, indent, functionContext);
    }

    // If this recur expression has a variableName, emit the result into a
    // named temp variable before any enclosing-scope drops are emitted.
    // Without this, the call happens AFTER the scope drops (use-after-free)
    // because the enclosing begin/match-arm emitter only gets back a raw
    // call string and emits drops first, then assigns the result.
    const tempVar = expr.$?.variableName;
    if (tempVar && expr.$?.type && !isUnitType(expr.$.type)) {
      const cType = getTypeString(expr.$.type, context);
      const tempVarName = getVariableNameForCodegen(tempVar, expr.$.env);
      if (!functionContext.declaredTempVars)
        functionContext.declaredTempVars = new Set();
      if (!functionContext.declaredTempVars.has(tempVarName)) {
        functionContext.declaredTempVars.add(tempVarName);
        context.emitter.emitLine(
          `${indent}${cType} ${tempVarName} = ${callCode};`
        );
      }
      return tempVarName;
    }

    return callCode;
  } else {
    return `// Error: No arguments for recur call ${exprToString(expr)}\n`;
  }
}
