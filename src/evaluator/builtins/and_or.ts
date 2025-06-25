import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import { createBooleanType, isBooleanType } from "../../types";
import {
  BooleanValue,
  createBooleanValue,
  createUnknownValue,
  isBooleanValue,
  isUnknownValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateAndOr({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const kind = expr.func.token.value === "and" ? "and" : "or";
  const args = expr.args;

  // Evaluate all args
  const values: (Value | undefined)[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    const evaluatedArg = context.evaluateExpression({
      expr: arg,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedArg.$ || !isBooleanType(evaluatedArg.$.type)) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected boolean type for "${kind}" argument, got:\n${exprToString(arg)}`,
      });
    }
    values.push(evaluatedArg.$.value);
    env = evaluatedArg.$.env;
  }

  let value: Value | undefined = undefined;
  if (values.every((val) => isBooleanValue(val))) {
    value = createBooleanValue(
      kind === "and"
        ? values.reduce((acc, val) => acc && (val as BooleanValue).value, true)
        : values.reduce((acc, val) => acc || (val as BooleanValue).value, false)
    );
  } else if (values.some((val) => isUnknownValue(val))) {
    value = createUnknownValue(createBooleanType());
  } else {
    value = undefined; // runtime value
  }

  expr.$ = {
    env: env,
    type: createBooleanType(),
    value,
    isMutable: false,
    pathCollection: [],
    isAccessingProperty: false,
  };
  return expr;
}
