import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createEffType, createStructType } from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateEffType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.__YoEff, 1);

  const resultTypeExpr = expr.args[0]!;

  // Evaluate the result type expression
  const evaluatedResultTypeExpr = context.evaluateExpression({
    expr: resultTypeExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedResultTypeExpr.$) {
    throw formatErrorMessage({
      token: resultTypeExpr.token,
      errorMessage: `Failed to evaluate the result type expression:\n${exprToString(
        resultTypeExpr
      )}`,
    });
  }
  if (!isTypeValue(evaluatedResultTypeExpr.$.value)) {
    throw formatErrorMessage({
      token: resultTypeExpr.token,
      errorMessage: `Expected type for result type, got:\n${exprToString(resultTypeExpr)}`,
    });
  }
  const resultType = evaluatedResultTypeExpr.$.value.value;

  // Create a default empty context type (struct with no fields)
  // This will be populated later when the effect is actually used
  const contextType = createStructType(env);

  // Create the effect type
  const effType = createEffType(resultType, contextType, env);
  const effTypeValue = createTypeValue(effType);

  expr.$ = {
    env: evaluatedResultTypeExpr.$.env,
    type: effTypeValue.type,
    value: effTypeValue,
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
