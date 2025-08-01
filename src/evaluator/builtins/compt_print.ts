import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import { VUnit } from "../../unit-value";
import { isComptStringValue, valueToString } from "../../value";
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
  // Accept any number of arguments (at least 1)
  if (expr.args.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected at least 1 argument for "compt_print", got 0`,
    });
  }

  const evaluatedValues: string[] = [];

  // Evaluate all arguments
  for (const argExpr of expr.args) {
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
        errorMessage: `Failed to evaluate argument for "compt_print": ${exprToString(argExpr)}`,
      });
    }
    env = evaluatedArgExpr.$.env;

    // Convert the value to string and store it
    if (isComptStringValue(evaluatedArgExpr.$.value)) {
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
    isMutable: false,
  };
  return expr;
}
