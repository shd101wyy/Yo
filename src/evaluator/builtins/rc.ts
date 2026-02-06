import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import { createUsizeType } from "../../types/creators";
import { isRcType } from "../../types/guards";
import { createNumberValue } from "../../value";
import { ValueTag } from "../../value-tag";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Get the reference counter of a value.
 * If it's value type, return 1.
 * Otherwise, return the actual reference count available in the runtime.
 * @param param0
 * @returns
 */
export function evaluateRc({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.rc, 1);

  const argExpr = expr.args[0]!;
  // Evaluate the expression
  const evaluatedExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate expression.`,
    });
  }
  env = evaluatedExpr.$.env;

  if (isRcType(evaluatedExpr.$.type)) {
    expr.$ = {
      env,
      type: createUsizeType(),
      value: undefined,
      pathCollection: [],
    };
  } else {
    // value types
    expr.$ = {
      env,
      type: createUsizeType(),
      value: createNumberValue(ValueTag.Usize, 1),
      pathCollection: [],
    };
  }

  return expr;
}
