import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { FuncCallExpr } from "../../expr";
import { isComptStringValue } from "../../value";
import { EvaluatorContext } from "../context";

export function evaluatePanic({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  // Check if panic is being called inside a function context
  if (context.isEvaluatingFunctionBodyOrAsyncBlock?.kind !== "function-body") {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `panic() can only be called inside a function body`,
    });
  }

  // Get the return type from the function context
  const functionReturnType =
    context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type;

  // If there's an argument, evaluate it and use as the panic message
  if (expr.args.length > 0) {
    const messageExpr = expr.args[0]!;
    const evaluatedMessageExpr = context.evaluateExpression({
      expr: messageExpr,
      env,
      context: {
        ...context,
      },
    });
    // Let's require it to be a compt_string for now
    if (!evaluatedMessageExpr.$) {
      throw formatErrorMessage({
        token: messageExpr.token,
        errorMessage: `Failed to evaluate panic message`,
      });
    }
    if (
      !evaluatedMessageExpr.$.value ||
      !isComptStringValue(evaluatedMessageExpr.$.value)
    ) {
      throw formatErrorMessage({
        token: messageExpr.token,
        errorMessage: `panic message must be a compt_string`,
      });
    }
  }

  // Set the expression's type to match the function's return type
  expr.$ = {
    env,
    type: functionReturnType,
    value: undefined, // panic never returns a value
    pathCollection: [],
  };

  return expr;
}
