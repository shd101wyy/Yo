import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import { VUnit } from "../../unit-value";
import { isComptStringValue, valueToString } from "../../value";
import { EvaluatorContext } from "../context";

/**
 * Expect having compile error
 */
export function evaluateComptExpectError({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const argExpr = expr.args[0]!;
  const messageExpr = expr.args[1];

  try {
    // Evaluate the expression
    context.evaluateExpression({
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
      isMutable: false,
    };
    return expr;
  }

  if (messageExpr) {
    const evaluatedMessageExpr = context.evaluateExpression({
      expr: messageExpr,
      env,
      context: {
        ...context,
      },
    });
    if (evaluatedMessageExpr.$?.value) {
      throw formatErrorMessage({
        token: expr.token,

        errorMessage: isComptStringValue(evaluatedMessageExpr.$.value)
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
