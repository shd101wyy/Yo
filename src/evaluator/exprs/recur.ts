import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import { createUnknownValue } from "../../value";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";
import { evaluateFunctionReturnTypeAgain } from "../types/function";

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

  // During CTFE capability analysis (isAnalyzingCtfeCapability is true), we short-circuit recur
  // to avoid infinite recursion. We just return an UnknownValue of the return type
  // since we're only checking that the function CAN be evaluated at compile time,
  // not actually computing the result with unknown values.
  if (context.isAnalyzingCtfeCapability) {
    const { returnType: recurReturnType } = evaluateFunctionReturnTypeAgain({
      functionType: isEvaluatingFunctionBodyOfType,
      calleeEnv: env,
      context: { ...context, isEvaluatingFunctionType: true },
    });

    expr.$ = {
      type: recurReturnType,
      value: createUnknownValue(recurReturnType, "recur_result"),
      env,
      pathCollection: [],
    };
    return expr;
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
