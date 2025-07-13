import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  FuncCallExpr,
} from "../../expr";
import { areTypesCompatible } from "../../types";
import { isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateThe({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.the, 2);

  const typeExpr = expr.args[0]!;
  const valueExpr = expr.args[1]!;

  // Evaluate the type expression first
  const evaluatedTypeExpr = context.evaluateExpression({
    expr: typeExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedTypeExpr.$) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `Failed to evaluate type expression.`,
    });
  }
  env = evaluatedTypeExpr.$.env;

  // Check if the first argument is a type value
  if (!evaluatedTypeExpr.$.value || !isTypeValue(evaluatedTypeExpr.$.value)) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `First argument to 'the' must be a type, got ${evaluatedTypeExpr.$.type}`,
    });
  }

  const expectedType = evaluatedTypeExpr.$.value.value;

  // Evaluate the value expression with the expected type
  const evaluatedValueExpr = context.evaluateExpression({
    expr: valueExpr,
    env,
    context: {
      ...context,
      expectedType: {
        type: expectedType,
        env,
      },
    },
  });
  if (!evaluatedValueExpr.$) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `Failed to evaluate value expression.`,
    });
  }
  env = evaluatedValueExpr.$.env;

  // Check type compatibility
  if (
    !areTypesCompatible(
      { type: expectedType, env },
      { type: evaluatedValueExpr.$.type, env }
    )
  ) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `Type mismatch: expected '${expectedType}', got '${evaluatedValueExpr.$.type}'`,
    });
  }

  // Return the value expression with the explicitly specified type
  expr.$ = {
    env,
    type: expectedType,
    value: evaluatedValueExpr.$.value,
    isMutable: evaluatedValueExpr.$.isMutable,
    pathCollection: evaluatedValueExpr.$.pathCollection,
  };
  return expr;
}
