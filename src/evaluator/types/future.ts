import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import { createFutureType } from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluate a Future type constructor call
 * For example:
 *
 * FutureType :: Future(i32);       // future that will yield i32
 * FutureType :: Future(String);    // future that will yield String
 * FutureType :: Future(unit);      // future that completes without returning a value
 *
 * async_fn :: (fn() -> Future(i32)) { ... };
 * future_var: Future(i32) := async_fn();  // calling async function returns Future(i32)
 */
export function evaluateFutureType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  // Future type constructor expects exactly 1 argument (element type)
  if (expr.args.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Future type constructor expects exactly 1 argument, got ${expr.args.length}. Usage: Future(TypeField)`,
    });
  }

  const elementTypeExpr = expr.args[0]!;

  // Evaluate element type expression
  const evaluatedElementTypeExpr = evaluateExpression({
    expr: elementTypeExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedElementTypeExpr.$) {
    throw formatErrorMessage({
      token: elementTypeExpr.token,
      errorMessage: `Failed to evaluate the element type expression for Future:\n${exprToString(
        elementTypeExpr
      )}`,
    });
  }
  env = evaluatedElementTypeExpr.$.env;

  // Check if the element type expression is a type
  if (!isTypeValue(evaluatedElementTypeExpr.$.value)) {
    throw formatErrorMessage({
      token: elementTypeExpr.token,
      errorMessage: `Future type constructor expects a type as its first argument, but got:\n${exprToString(
        elementTypeExpr
      )}`,
    });
  }

  const childType = evaluatedElementTypeExpr.$.value.value;

  // Create the Future type
  const futureType = createFutureType(childType, env);

  const typeValueForFuture = createTypeValue(futureType);

  expr.$ = {
    env,
    type: typeValueForFuture.type,
    value: typeValueForFuture,
    pathCollection: [],
  };
  return expr;
}
