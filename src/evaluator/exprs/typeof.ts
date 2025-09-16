import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateTypeOf({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinFunctions.typeof, 1)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "typeof" with 1 argument, got:\n${exprToString(expr)}`,
    });
  }
  const typeExpr = expr.args[0]!;

  // Evaluate the expression
  const evaluatedExpr = context.evaluateExpression({
    expr: typeExpr,
    env,
    context: {
      ...context,
    },
  });
  if (evaluatedExpr.$?.env) {
    env = evaluatedExpr.$.env;
  }

  // Check if the expression has a type
  if (!evaluatedExpr.$?.type) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `Expected type for expression, got:\n${exprToString(typeExpr)}`,
    });
  }
  const type = evaluatedExpr.$.type;
  const value = createTypeValue(type);
  expr.$ = {
    env,
    type: value.type,
    value: value,
    pathCollection: [],
  };
  return expr;
}
