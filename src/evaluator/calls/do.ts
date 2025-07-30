import { formatErrorMessage } from "../../error";
import { FuncCallExpr } from "../../expr";
import { EvaluatorContext } from "../context";

/**
 * Handle `do` expressions - these indicate CPS transformation is needed
 */
export function evaluateDoExpression({
  expr,
  context,
}: {
  expr: FuncCallExpr;
  context: EvaluatorContext;
}): FuncCallExpr {
  // Record that this function uses `do` and needs CPS transformation
  if (context.isEvaluatingFunctionBody) {
    if (!context.isEvaluatingFunctionBody.usedDo) {
      context.isEvaluatingFunctionBody.usedDo = [];
    }
    context.isEvaluatingFunctionBody.usedDo.push(expr);
  }

  // For now, just throw an error since `do` should be transformed away
  throw formatErrorMessage({
    token: expr.token,
    errorMessage: `'do' expressions need CPS transformation. This should not be reached in normal evaluation.`,
  });
}
