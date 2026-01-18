import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";

export function evaluateRecur({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  if (context.isEvaluatingFunctionBodyOrAsyncBlock?.kind !== "function-body") {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected a function type for recur, got:\n${exprToString(expr)}`,
    });
  }

  const isEvaluatingFunctionBodyOfType =
    context.isEvaluatingFunctionBodyOrAsyncBlock.type;

  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected recur, got:\n${exprToString(expr)}`,
    });
  }

  const evaluatedRecurExpr = evaluateFunctionCall({
    expr: expr,
    env,
    givenFunc: {
      type: isEvaluatingFunctionBodyOfType,
      value: context.isEvaluatingFunctionBodyOrAsyncBlock.value ?? undefined,
    },
    context: { ...context },
  });

  return evaluatedRecurExpr;
}
