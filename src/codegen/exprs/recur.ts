import { exprIsFunctionCall, exprToString, type FnCallExpr } from "../../expr";
import type { FunctionGenerationContext } from "../functions/context";
import { type CodeGenContext, getVariableNameForCodegen } from "../utils";
import { generateDeferredDupExpressions } from "./drop-dup";
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

    return `${context.currentFunctionName}(${fullArgs})`;
  } else {
    return `// Error: No arguments for recur call ${exprToString(expr)}\n`;
  }
}
