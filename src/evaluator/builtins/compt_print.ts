import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { VUnit } from "../../unit-value";
import { valueToString } from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateComptPrint({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.compt_print, 1);
  const argExpr = expr.args[0]!;

  // Evaluate the expression
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
      errorMessage: `Expected boolean value for "compt_assert", got:\n${exprToString(argExpr)}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Print the value to the console
  console.log(valueToString(evaluatedArgExpr.$.value));

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
