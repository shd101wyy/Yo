import { Environment } from "../../env";
import { Expr } from "../../expr";
import { EvaluateExpressionFn, EvaluatorContext } from "../context";

let _evaluateExpression: EvaluateExpressionFn | undefined = undefined;

export function setEvaluateExpressionFn(fn: EvaluateExpressionFn) {
  _evaluateExpression = fn;
}

export function evaluateExpression({
  expr,
  env,
  context,
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  if (!_evaluateExpression) {
    throw new Error("Internal Error: evaluateExpression function is not set.");
  }
  return _evaluateExpression({ expr, env, context });
}
