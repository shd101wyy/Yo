import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, type FnCallExpr } from "../../expr";
import { VUnit } from "../../unit-value";
import { isComptimeStringValue, valueToString } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateComptimePrint({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  // Accept any number of arguments (at least 1)
  if (expr.args.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected at least 1 argument for "comptime_print", got 0`,
    });
  }

  const evaluatedValues: string[] = [];

  // Evaluate all arguments
  for (const argExpr of expr.args) {
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
        errorMessage: `Failed to evaluate argument for "comptime_print": ${exprToString(argExpr)}`,
      });
    }
    env = evaluatedArgExpr.$.env;

    // Convert the value to string and store it
    if (isComptimeStringValue(evaluatedArgExpr.$.value)) {
      evaluatedValues.push(evaluatedArgExpr.$.value.value);
    } else {
      evaluatedValues.push(valueToString(evaluatedArgExpr.$.value));
    }
  }

  // Print all values to the console only if we're not validating a function definition
  if (!context.isValidatingFunctionDefinition && context.isExecuting) {
    console.log(...evaluatedValues);
  }

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}
