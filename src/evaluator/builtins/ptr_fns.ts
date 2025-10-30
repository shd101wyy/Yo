import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createMutPtrType, isMutPtrType } from "../../types";
import { isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

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
  if (expectedType && isMutPtrType(expectedType.type)) {
    // If the expected type is a pointer type, we need to use the base type
    // for the reference creation.
    expectedType = {
      ...expectedType,
      type: expectedType.type.type,
    };
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
      errorMessage: `Failed to evaluate the argument expression for reference:\n${exprToString(
        argExpr
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
        argExpr
      )}`,
    });
  }
  // Create pointer value
  else {
    const argType = evaluatedArgExpr.$.type;
    const pointerType = createMutPtrType(argType);

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

export function evaluatePtrDereference({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_ptr_deref, 1);
  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = context.evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for pointer dereference:\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  const argType = evaluatedArgExpr.$.type;
  if (!isMutPtrType(argType)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Cannot dereference a non-pointer type:\n${exprToString(
        argExpr
      )}`,
    });
  }

  // Create dereferenced value
  const derefType = argType.type;
  expr.$ = {
    env,
    type: derefType,
    value: undefined, // dereference is only available for runtime
    pathCollection: evaluatedArgExpr.$.pathCollection,
  };
  attachTempVariableToExpr(expr, false); // borrow the dereferenced value
  return expr;
}
