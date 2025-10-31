import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import { createMutPtrType, isMutPtrType } from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

/**
 * Evaluate a raw pointer call
 * For example:
 *
 * I32Ptr :: *(i32);
 * x := 1;
 * p := &(x); // p: *(i32)
 */
export function evaluateRawPointerCall({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const argExpr = expr.args[0]!;

  let expectedType = context.expectedType;
  if (expectedType && isMutPtrType(expectedType.type)) {
    // If the expected type is a reference type, we need to use the base type
    // for the reference creation.
    expectedType = {
      ...expectedType,
      type: expectedType.type.type,
    };
  } else {
    // QUESTION: Should we set expectedType to undefined?
  }

  const evaluatedArgExpr = context.evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
      expectedType,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for pointer:\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argExpr is a type
  // Create pointer type
  if (isTypeValue(evaluatedArgExpr.$.value)) {
    const typeValue = evaluatedArgExpr.$.value;
    const baseType = typeValue.value;
    // Create the pointer type
    const pointerType = createMutPtrType(baseType, {
      ...context,
    });
    const typeValueForPointer = createTypeValue(pointerType);
    expr.$ = {
      env,
      type: typeValueForPointer.type,
      value: typeValueForPointer,
      pathCollection: [],
    };
    return expr;
  }
  // Create pointer value
  else {
    // Throw error. Should use & to create a pointer to a value.
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Cannot create a pointer to a value. Use "&" to create a pointer to a value:\n${exprToString(
        argExpr
      )}`,
    });
  }
}
