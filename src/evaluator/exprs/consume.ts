import { checkBorrowings } from "../../borrow";
import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr, setExprAsConsumed } from "../../expr";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";

/**
 * NOTE: Let's use the `drop` function to replace this
 */
export function evaluateConsume({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  /*
  if (!exprIsFunctionCallOf(expr, BuiltinFunctions.consume, 1)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "consume" with 1 argument, got:\n${exprToString(expr)}`,
    });
  }
  */
  const consumeArgExpr = expr.args[0]!;

  // Evaluate the consume argument
  const evaluatedConsumeArgExpr = context.evaluateExpression({
    expr: consumeArgExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedConsumeArgExpr.$) {
    throw formatErrorMessage({
      token: consumeArgExpr.token,
      errorMessage: `Failed to evaluate the consume argument:\n${exprToString(consumeArgExpr)}`,
    });
  }

  /*
    // QUESTION: Should we limit the consume argument to Linear type?
    const argType = evaluatedConsumeArgExpr.$.type;
    if (!isLinearOrType0Type(typeOfType(argType))) {
      throw formatErrorMessage(
        consumeArgExpr.token,
        `Expected "Linear" type for consume argument, got:\n${exprToString(consumeArgExpr)}`
      );
    }
    */
  // Check if the consume argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedConsumeArgExpr);

  // Set the consume argument as consumed
  env = evaluatedConsumeArgExpr.$.env;
  env = setExprAsConsumed(evaluatedConsumeArgExpr, env);

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
