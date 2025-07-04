import { checkBorrowings } from "../../borrow";
import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr, setExprAsConsumed } from "../../expr";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";

/**
 * Explicitly drop a value.
 * This function is related with RAII.
 */
export function evaluateDrop({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const argExpr = expr.args[0]!;
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
      errorMessage: `Failed to evaluate the argument expression for "drop":\n${exprToString(
        argExpr
      )}`,
    });
  }

  // Check if the drop argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedArgExpr);

  // Set the expression as consumed
  env = evaluatedArgExpr.$.env;
  env = setExprAsConsumed(evaluatedArgExpr, env, context);

  // TODO: Handle calling drop function.
  // In theory, the Free values will be ignored.

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
