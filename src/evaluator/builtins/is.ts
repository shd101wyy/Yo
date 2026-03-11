import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import { createBooleanType } from "../../types/creators";
import { isDynType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import {
  createUnknownValue,
  isTypeValue,
  type UnknownValue,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluate `is(dyn_value, T)`.
 *
 * Checks if the Dyn value's runtime type ID matches the compile-time type T.
 *
 * - dyn_value must be a Dyn type value.
 * - T must be a compile-time Type argument.
 * - Returns bool.
 */
export function evaluateIs({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.is, 2);

  // First argument: the dyn value (runtime)
  const dynExpr = expr.args[0]!;
  const evaluatedDynExpr = evaluateExpression({
    expr: dynExpr,
    env,
    context: { ...context },
  });
  if (!evaluatedDynExpr.$) {
    throw formatErrorMessage({
      token: dynExpr.token,
      errorMessage: `Failed to evaluate dyn value argument for is.`,
    });
  }
  env = evaluatedDynExpr.$.env;

  const dynType = evaluatedDynExpr.$.type;
  if (!dynType || !isDynType(dynType)) {
    throw formatErrorMessage({
      token: dynExpr.token,
      errorMessage: `is expects a Dyn type as first argument, got ${
        dynType ? typeToString(dynType) : "unknown"
      }.`,
    });
  }

  // Second argument: the target type T (comptime)
  const typeExpr = expr.args[1]!;
  const evaluatedTypeExpr = evaluateExpression({
    expr: typeExpr,
    env,
    context: { ...context },
  });
  if (!evaluatedTypeExpr.$) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `Failed to evaluate type argument for is.`,
    });
  }
  env = evaluatedTypeExpr.$.env;

  if (!evaluatedTypeExpr.$.value || !isTypeValue(evaluatedTypeExpr.$.value)) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `is expects a type as second argument, got ${
        evaluatedTypeExpr.$.type
          ? typeToString(evaluatedTypeExpr.$.type)
          : "unknown"
      }.`,
    });
  }

  // Result type is bool
  const resultType = createBooleanType();
  const resultValue = createUnknownValue(resultType, {
    env,
    context,
  }) as UnknownValue;

  expr.$ = {
    env,
    type: resultType,
    value: resultValue,
    pathCollection: [],
  };
  return expr;
}
