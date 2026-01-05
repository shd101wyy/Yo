import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  Expr,
  exprIsAtom,
  FuncCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  ArrayType,
  isArrayType,
  typeToString,
} from "../../types";
import {
  createArrayValue,
  createUnknownValue,
  isNumberValue,
  isTypeValue,
  isUnknownValue,
  Value,
  valueToString,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Helper function to handle Array type fill method calls
 * Handles expressions like: Array(i32, 5).fill(0)
 */
export function evaluateArrayFillMethod({
  expr,
  arrayType,
  fillValueArg,
  env,
  context,
}: {
  expr: FuncCallExpr;
  arrayType: ArrayType; // The ArrayType to create and fill
  fillValueArg: Expr;
  env: Environment;
  context: EvaluatorContext;
}): { expr: FuncCallExpr; env: Environment } {
  // Evaluate the fill value argument
  const evaluatedFillValueArg = evaluateExpression({
    expr: fillValueArg,
    env,
    context: {
      ...context,
      expectedType: { type: arrayType.childType, env },
    },
  });

  if (evaluatedFillValueArg.$?.env) {
    env = evaluatedFillValueArg.$.env;
  }

  const fillValueType = evaluatedFillValueArg.$?.type;
  const fillValue = evaluatedFillValueArg.$?.value;

  if (!fillValueType) {
    throw formatErrorMessage({
      token: fillValueArg.token,
      errorMessage: `Failed to evaluate fill value`,
    });
  }

  // Check type compatibility
  if (
    !areTypesCompatible(
      { type: arrayType.childType, env },
      { type: fillValueType, env }
    )
  ) {
    throw formatErrorMessage({
      token: fillValueArg.token,
      errorMessage: `Fill value type ${typeToString(fillValueType)} is not compatible with array element type ${typeToString(arrayType.childType)}`,
    });
  }

  // All types can now be used with Array.fill since we removed Linear/Free distinction

  // Extract array length from the ArrayType
  // arrayType.length should be a Value with a compile-time known integer
  const lengthValue = arrayType.length;

  // If the length is an UnknownValue, we can't create a concrete array at compile time
  if (isUnknownValue(lengthValue)) {
    // Return an UnknownValue for the array since we can't determine its concrete elements
    const arrayValue = createUnknownValue(arrayType);

    expr.$ = {
      env,
      type: arrayType,
      value: arrayValue,
      pathCollection: [],
    };

    attachTempVariableToExpr(expr, true);
    return { expr, env };
  }

  // Check if lengthValue is a concrete numeric value
  let arrayLength: number;
  if (isNumberValue(lengthValue)) {
    const lengthVal = lengthValue.value;
    arrayLength = typeof lengthVal === "bigint" ? Number(lengthVal) : lengthVal;
    if (!Number.isInteger(arrayLength) || arrayLength < 0) {
      throw formatErrorMessage({
        token: fillValueArg.token,
        errorMessage: `Array length must be a non-negative integer, got ${arrayLength}`,
      });
    }
  } else {
    throw formatErrorMessage({
      token: fillValueArg.token,
      errorMessage: `Array length must be a compile-time known integer, got ${valueToString(lengthValue)}`,
    });
  }

  // Create array elements by repeating the fill value
  const arrayElements: Value[] = [];

  // If fillValue is not available (e.g., it's a runtime variable),
  // we cannot create a concrete array at compile time
  if (!fillValue || isUnknownValue(fillValue)) {
    // Return an UnknownValue for the array since we can't determine its concrete elements
    const arrayValue = createUnknownValue(arrayType);

    expr.$ = {
      env,
      type: arrayType,
      value: arrayValue,
      pathCollection: [],
    };

    attachTempVariableToExpr(expr, true);
    return { expr, env };
  }

  for (let i = 0; i < arrayLength; i++) {
    arrayElements.push(fillValue);
  }

  // Create array value filled with the given value
  const arrayValue = createArrayValue(arrayType, arrayElements);

  expr.$ = {
    env,
    type: arrayType,
    value: arrayValue,
    pathCollection: [],
  };

  // Set temp variable which holds the result of the function call
  attachTempVariableToExpr(expr, true);

  return { expr, env };
}

/**
 * Check if an expression is an Array type fill method call
 */
export function isArrayTypeFillMethodCall(
  receiverArg: Expr,
  methodExpr: Expr
): boolean {
  return (
    isTypeValue(receiverArg.$?.value) &&
    isArrayType(receiverArg.$.value.value) &&
    exprIsAtom(methodExpr) &&
    methodExpr.token.value === "fill"
  );
}
