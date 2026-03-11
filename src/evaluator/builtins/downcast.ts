import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import { isDynType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import {
  createUnknownValue,
  isTypeValue,
  type UnknownValue,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { createOptionType } from "./rc-fns";

/**
 * Evaluate `downcast(dyn_value, T)`.
 *
 * Safe downcast: checks if the Dyn value's runtime type matches T,
 * returning Option(T). Dyn only wraps object types (reference-counted),
 * so the result is always an owned reference.
 */
export function evaluateDowncast({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.downcast, 2);

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
      errorMessage: `Failed to evaluate dyn value argument for downcast.`,
    });
  }
  env = evaluatedDynExpr.$.env;

  const dynType = evaluatedDynExpr.$.type;
  if (!dynType || !isDynType(dynType)) {
    throw formatErrorMessage({
      token: dynExpr.token,
      errorMessage: `downcast expects a Dyn type as first argument, got ${
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
      errorMessage: `Failed to evaluate type argument for downcast.`,
    });
  }
  env = evaluatedTypeExpr.$.env;

  if (!evaluatedTypeExpr.$.value || !isTypeValue(evaluatedTypeExpr.$.value)) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `downcast expects a type as second argument, got ${
        evaluatedTypeExpr.$.type
          ? typeToString(evaluatedTypeExpr.$.type)
          : "unknown"
      }.`,
    });
  }

  const targetType = evaluatedTypeExpr.$.value.value;

  // Construct Option(T) — Dyn only wraps object types
  const { optionType, env: envWithOption } = createOptionType(
    targetType,
    env,
    context
  );
  env = envWithOption;

  const resultValue = createUnknownValue(optionType, {
    env,
    context,
  }) as UnknownValue;

  expr.$ = {
    env,
    type: optionType,
    value: resultValue,
    pathCollection: [],
  };

  attachTempVariableToExpr(expr, true);

  return expr;
}
