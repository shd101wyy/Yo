import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createSliceType } from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateSliceType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.Slice, 1);

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
      errorMessage: `Expected type for element type, got:\n${exprToString(elementTypeExpr)}

If you are creating an array value with 1 element, please consider adding a "," in the end, like [1,]`,
    });
  }
  const elementType = evaluatedElementTypeExpr.$.value.value;

  const sliceType = createSliceType(elementType);
  const sliceTypeValue = createTypeValue(sliceType);

  expr.$ = {
    env: evaluatedElementTypeExpr.$.env,
    type: sliceTypeValue.type,
    value: sliceTypeValue,
    pathCollection: [],
  };
  return expr;
}
