import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createPtrType, isPtrType } from "../../types";
import { isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluate a address call
 * For example:
 *
 * &(x)
 */
export function evaluateAddressCall({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_address_of, 1);

  const argExpr = expr.args[0]!;

  let expectedType = context.expectedType;
  if (expectedType && isPtrType(expectedType.type)) {
    // If the expected type is a pointer type, we need to use the base type
    // for the reference creation.
    expectedType = {
      ...expectedType,
      type: expectedType.type.childType,
    };
  }

  const evaluatedArgExpr = evaluateExpression({
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
      errorMessage: `Failed to evaluate the argument expression for reference:\n${exprToString(
        argExpr,
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argExpr is a type
  if (isTypeValue(evaluatedArgExpr.$.value)) {
    // Throw error. Should use * to create pointer to type
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Cannot create a pointer to a type. Did you mean to use "*"?\n${exprToString(
        argExpr,
      )}`,
    });
  }
  // Create pointer value
  else {
    const argType = evaluatedArgExpr.$.type;
    const pointerType = createPtrType(argType);

    expr.$ = {
      env,
      type: pointerType,
      value: undefined, // reference is only available for runtime
      pathCollection: evaluatedArgExpr.$.pathCollection,
    };
    attachTempVariableToExpr(expr, false);
    return expr;
  }
}
