import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import { createUsizeType } from "../../types/creators";
import {
  createUnknownValue,
  isTypeValue,
  type UnknownValue,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateTypeId({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.typeid, 1);

  const typeExpr = expr.args[0]!;
  // Evaluate the expression
  const evaluatedExpr = evaluateExpression({
    expr: typeExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedExpr.$) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `Failed to evaluate expression for typeid.`,
    });
  }
  env = evaluatedExpr.$.env;

  // typeid expects a type argument
  if (!evaluatedExpr.$.value || !isTypeValue(evaluatedExpr.$.value)) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `typeid expects a type argument.`,
    });
  }

  // The result is a runtime usize value (address of a static)
  const typeSizeValue = createUnknownValue(createUsizeType(), {
    env,
    context,
  }) as UnknownValue;

  expr.$ = {
    env,
    type: createUsizeType(),
    value: typeSizeValue,
    pathCollection: [],
  };
  return expr;
}
