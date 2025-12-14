import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  FuncCallExpr,
  setExprAsConsumed,
} from "../../expr";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluate the `consume` builtin function.
 * Set the expression as consumed in the environment.
 */
export function evaluateConsume({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.consume, 1);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate expression.`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Mark the expression as consumed in the environment
  env = setExprAsConsumed(evaluatedArgExpr, env);

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}
