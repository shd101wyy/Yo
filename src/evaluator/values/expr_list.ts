import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import { isExprType } from "../../type-checker";
import {
  createExprListValue,
  ExprValue,
  isExprValue,
  isUnknownValue,
  UnknownValue,
  valueToString,
} from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateExprListValue({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const elements: (ExprValue | UnknownValue)[] = [];
  const args = expr.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const evaluatedArg = context.evaluateExpression({
      expr: arg,
      env,
      context: {
        ...context,
      },
    });
    if (
      !evaluatedArg.$ ||
      !isExprType(evaluatedArg.$.type) ||
      !evaluatedArg.$.value
    ) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Failed to evaluate expr_list element. Expected compile-time known expr value:\n${exprToString(arg)}`,
      });
    }
    env = evaluatedArg.$.env;
    const value = evaluatedArg.$.value;

    if (
      isExprValue(value) ||
      (isUnknownValue(value) && isExprType(value.type))
    ) {
      elements.push(value);
    } else {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected compile-time known expr value, got ${valueToString(value)}`,
      });
    }
  }

  const exprListValue = createExprListValue(elements);
  expr.$ = {
    env,
    type: exprListValue.type,
    value: exprListValue,
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
