import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { expectExprToBeFunctionCallOf, FuncCallExpr } from "../../expr";
import { isModuleType, ModuleType } from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/*

    use_id :: 
      (fn(
        forall(T : Type),
        value : T,
        using(IdInstance : (T <: Id))
      ) -> value) {
      return IdInstance.id(value);
    };

    Here T <: Id means that T is a subtype of Id, which is a type that has an id method.
 */
export function evaluateSubtypeOf({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, "<:", 2);
  const lhsExpr = expr.args[0]!;
  const rhsExpr = expr.args[1]!;

  // Evaluate the lhsExpr
  const evaluatedLhs = evaluateExpression({
    expr: lhsExpr,
    env,
    context: {
      ...context,
    },
  });

  // Expect the lhs to be a type
  if (
    !evaluatedLhs.$ ||
    !evaluatedLhs.$.value ||
    !isTypeValue(evaluatedLhs.$.value)
  ) {
    throw formatErrorMessage({
      token: lhsExpr.token,
      errorMessage: `Expected type for left-hand side expression.`,
    });
  }
  env = evaluatedLhs.$.env;
  const typeValue = evaluatedLhs.$.value;

  // Evaluate the rhsExpr
  const evaluatedRhs = evaluateExpression({
    expr: rhsExpr,
    env,
    context: {
      ...context,
    },
  });

  // Expect the rhs to be a module type
  if (
    !evaluatedRhs.$ ||
    !evaluatedRhs.$.value ||
    !isTypeValue(evaluatedRhs.$.value) ||
    !isModuleType(evaluatedRhs.$.value.value)
  ) {
    throw formatErrorMessage({
      token: rhsExpr.token,
      errorMessage: `Expected module type for right-hand side expression.`,
    });
  }
  env = evaluatedRhs.$.env;
  const moduleType = evaluatedRhs.$.value.value;

  if (moduleType.receiverType) {
    throw formatErrorMessage({
      token: rhsExpr.token,
      errorMessage: `Expected module type already has a receiver type assigned.`,
    });
  }

  /// Override the assigned value of the This element with the typeValue.
  const newModuleType: ModuleType = {
    ...moduleType,
    receiverType: typeValue.value, // Set the subtype to the typeValue
  };
  const newModuleTypeValue = createTypeValue(newModuleType);

  expr.$ = {
    env,
    value: newModuleTypeValue,
    type: newModuleTypeValue.type,
    pathCollection: evaluatedRhs.$.pathCollection,
  };
  return expr;
}
