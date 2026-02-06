import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { createComptimeListType } from "../../types/creators";
import { createTypeValue, isTypeValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateComptimeListType({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.ComptimeList, 1);

  const elementTypeExpr = expr.args[0]!;

  // Evaluate the element type expression
  const evaluatedElementTypeExpr = evaluateExpression({
    expr: elementTypeExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedElementTypeExpr.$) {
    throw formatErrorMessage({
      token: elementTypeExpr.token,
      errorMessage: `Failed to evaluate the element type expression:\n${exprToString(
        elementTypeExpr
      )}`,
    });
  }
  if (!isTypeValue(evaluatedElementTypeExpr.$.value)) {
    throw formatErrorMessage({
      token: elementTypeExpr.token,
      errorMessage: `Expected type for element type, got:\n${exprToString(elementTypeExpr)}`,
    });
  }
  const childType = evaluatedElementTypeExpr.$.value.value;

  const comptimeListType = createComptimeListType(childType);
  const comptimeListTypeValue = createTypeValue(comptimeListType);

  expr.$ = {
    env: evaluatedElementTypeExpr.$.env,
    type: comptimeListTypeValue.type,
    value: comptimeListTypeValue,
    pathCollection: [],
  };
  return expr;
}
