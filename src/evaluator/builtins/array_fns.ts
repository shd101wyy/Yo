import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { isArrayType } from "../../types";
import { EvaluatorContext } from "../context";

export function evaluateYoArrayLength({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_array_length, 1);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = context.evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  if (!isArrayType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected array type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }

  const lengthValue = evaluatedArgExpr.$.type.length;
  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: lengthValue.type,
    value: lengthValue,
    isMutable: false,
    pathCollection: [],
    isAccessingProperty: false,
  };
  return expr;
}
