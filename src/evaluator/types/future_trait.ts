import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import { createTraitType, typeOfType } from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluates the `Future(T)` syntax.
 * Creates a trait type that represents a future trait (similar to Fn trait pattern).
 *
 * Example:
 *   Future(i32)       // future that will yield i32
 *   Future(String)    // future that will yield String
 *   Future(unit)      // future that completes without returning a value
 *
 * This creates a trait type with `isFuture` set to the child type.
 *
 * The Future trait can be used with:
 * - Impl(Future(T)) for static dispatch with futures
 * - Dyn(Future(T)) for dynamic dispatch
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
      errorMessage: `Future type constructor expects exactly 1 argument, got ${expr.args.length}. Usage: Future(T)`,
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

  const outputType = evaluatedElementTypeExpr.$.value.value;

  // Create the Future trait type (similar to how Fn trait type is created)
  const futureTraitType = createTraitType(env);

  // Set the isFuture field to the child type
  futureTraitType.isFuture = { outputType };

  // Use canonical ID format to match createFutureTraitType
  // This ensures Future(unit) from type annotations and async blocks have the same ID
  futureTraitType.id = `future_trait_${outputType.id}`;

  expr.$ = {
    env,
    type: typeOfType(futureTraitType),
    value: createTypeValue(futureTraitType),
    pathCollection: [],
  };

  return expr;
}
