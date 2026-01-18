import { exprIsFunctionCall, exprToString, FnCallExpr } from "../../expr";
import { FunctionGenerationContext } from "../functions/context";
import { CodeGenContext, getVariableNameForCodegen } from "../utils";
import { generateDeferredDupExpressions } from "./drop_dup";
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
    return `${context.currentFunctionName}(${argsList})`;
  } else {
    return `// Error: No arguments for recur call ${exprToString(expr)}\n`;
  }
}
