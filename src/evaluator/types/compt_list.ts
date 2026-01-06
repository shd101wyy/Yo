import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createComptListType } from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateComptListType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.ComptList, 1);

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
        elementTypeExpr,
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

  const comptListType = createComptListType(childType);
  const comptListTypeValue = createTypeValue(comptListType);

  expr.$ = {
    env: evaluatedElementTypeExpr.$.env,
    type: comptListTypeValue.type,
    value: comptListTypeValue,
    pathCollection: [],
  };
  return expr;
}
