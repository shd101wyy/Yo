import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";

export function evaluateRecur({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  const isEvaluatingFunctionBodyOfType = context.isEvaluatingFunctionBody?.type;
  if (!isEvaluatingFunctionBodyOfType) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected a function type for recur, got:\n${exprToString(expr)}`,
    });
  }
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected recur, got:\n${exprToString(expr)}`,
    });
  }

  return evaluateFunctionCall({
    expr: expr,
    env,
    givenFunc: {
      type: isEvaluatingFunctionBodyOfType,
      value: context.isEvaluatingFunctionBody?.value ?? undefined,
      // createTypeValue(isEvaluatingFunctionBodyOfType),
    },
    context: { ...context },
  });
}
