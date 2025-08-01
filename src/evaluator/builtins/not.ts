import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import { createBooleanType, isBooleanType } from "../../types";
import { createBooleanValue, isBooleanValue } from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateNot({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const notArg = expr.args[0]!;

  // Evaluate the argument expression
  const evaluatedNotArg = context.evaluateExpression({
    expr: notArg,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedNotArg.$ || !isBooleanType(evaluatedNotArg.$.type)) {
    throw formatErrorMessage({
      token: notArg.token,
      errorMessage: `Expected boolean type for "not" argument, got:\n${exprToString(notArg)}`,
    });
  }
  env = evaluatedNotArg.$.env;

  let value = evaluatedNotArg.$.value;
  if (isBooleanValue(value)) {
    value = createBooleanValue(!value.value);
  }

  expr.$ = {
    env: evaluatedNotArg.$.env,
    type: createBooleanType(),
    value,
    isMutable: false,

    isAccessingProperty: false,
  };
  return expr;
}
