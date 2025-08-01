import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
  setExprAsConsumed,
} from "../../expr";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";

/**
 * consume a variable
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
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.consume, 1);

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

  // Set the consume argument as consumed
  env = evaluatedConsumeArgExpr.$.env;
  env = setExprAsConsumed(evaluatedConsumeArgExpr, env, context);

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    isMutable: false,
  };
  return expr;
}
