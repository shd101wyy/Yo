import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { cloneExpr, exprToString, type FnCallExpr } from "../../expr";
import { VUnit } from "../../unit-value";
import { isComptimeStringValue, valueToString } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Expect having compile error
 */
export function evaluateComptimeExpectError({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const argExpr = cloneExpr(expr.args[0]!);
  const messageExpr = expr.args[1] ? cloneExpr(expr.args[1]!) : undefined;

  try {
    // Evaluate the expression
    evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
      },
    });
  } catch (error) {
    // The error is expected, so we do nothing
    expr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      pathCollection: [],
    };
    return expr;
  }

  if (messageExpr) {
    const evaluatedMessageExpr = evaluateExpression({
      expr: messageExpr,
      env,
      context: {
        ...context,
      },
    });
    if (evaluatedMessageExpr.$?.value) {
      throw formatErrorMessage({
        token: expr.token,

        errorMessage: isComptimeStringValue(evaluatedMessageExpr.$.value)
          ? evaluatedMessageExpr.$.value.value
          : valueToString(evaluatedMessageExpr.$.value),
      });
    }
  }

  throw formatErrorMessage({
    token: expr.token,
    errorMessage: `Expected compile error, but the expression was evaluated successfully:\n${exprToString(argExpr)}`,
  });
}
