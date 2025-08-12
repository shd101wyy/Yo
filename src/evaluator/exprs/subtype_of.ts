import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { expectExprToBeFunctionCallOf, FuncCallExpr } from "../../expr";
import { isModuleType, ModuleType } from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

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
  const evaluatedLhs = context.evaluateExpression({
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
  const evaluatedRhs = context.evaluateExpression({
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

  // Expect the moduleType has Self element, but has no assigned value there.
  const selfElement = moduleType.elements.find(
    (element) => element.label === "Self"
  );
  if (!selfElement) {
    throw formatErrorMessage({
      token: rhsExpr.token,
      errorMessage: `Expected module type to have a Self element.`,
    });
  }
  if (selfElement.assignedValue) {
    throw formatErrorMessage({
      token: rhsExpr.token,
      errorMessage: `Expected module type Self element to not have an assigned value.`,
    });
  }

  /// Override the assigned value of the Self element with the typeValue.
  const newModuleType: ModuleType = {
    ...moduleType,
    elements: moduleType.elements.map((element) => {
      if (element.label === "Self") {
        return {
          ...element,
          assignedValue: typeValue, // Assign the typeValue to the Self element
        };
      } else {
        return element;
      }
    }),
    subtype: typeValue.value, // Set the subtype to the typeValue
  };
  const newModuleTypeValue = createTypeValue(newModuleType);

  expr.$ = {
    env,
    value: newModuleTypeValue,
    type: newModuleTypeValue.type,
    isMutable: false,
    pathCollection: evaluatedRhs.$.pathCollection,
  };
  return expr;
}
