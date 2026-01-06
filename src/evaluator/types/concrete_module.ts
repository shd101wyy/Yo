import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import { createModuleType, typeOfType } from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluates the `Concrete(T)` syntax.
 * Creates a marker module type that specifies the concrete type for Impl.
 *
 * Example:
 *   extern "Yo", yo_io_future : Type;
 *   IOReadFuture :: Impl(Concrete(yo_io_future), Future(i32));
 *
 * The Concrete(T) module is used in Impl(...) to explicitly set the
 * resolvedConcreteType of the resulting SomeType to T.
 *
 * This is particularly useful for extern types where the C representation
 * is known but doesn't fit the normal async block state machine pattern.
 */
export function evaluateConcreteType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  // Concrete type constructor expects exactly 1 argument (the concrete type)
  if (expr.args.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Concrete type constructor expects exactly 1 argument, got ${expr.args.length}. Usage: Concrete(T)`,
    });
  }

  const concreteTypeExpr = expr.args[0]!;

  // Evaluate the concrete type expression
  const evaluatedConcreteTypeExpr = evaluateExpression({
    expr: concreteTypeExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedConcreteTypeExpr.$) {
    throw formatErrorMessage({
      token: concreteTypeExpr.token,
      errorMessage: `Failed to evaluate the concrete type expression for Concrete:\n${exprToString(
        concreteTypeExpr,
      )}`,
    });
  }
  env = evaluatedConcreteTypeExpr.$.env;

  // Check if the concrete type expression is a type
  if (!isTypeValue(evaluatedConcreteTypeExpr.$.value)) {
    throw formatErrorMessage({
      token: concreteTypeExpr.token,
      errorMessage: `Concrete type constructor expects a type as its argument, but got:\n${exprToString(
        concreteTypeExpr,
      )}`,
    });
  }

  const concreteType = evaluatedConcreteTypeExpr.$.value.value;

  // Create the Concrete module type
  const concreteModuleType = createModuleType(env);

  // Set the isConcrete field to mark this as a ConcreteModuleType
  concreteModuleType.isConcrete = { concreteType };

  // Use canonical ID format
  concreteModuleType.id = `concrete_module_${concreteType.id}`;

  expr.$ = {
    env,
    type: typeOfType(concreteModuleType),
    value: createTypeValue(concreteModuleType),
    pathCollection: [],
  };

  return expr;
}
