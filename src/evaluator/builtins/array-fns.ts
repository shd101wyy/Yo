import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import { isArrayType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import {
  createArrayValue,
  createUnknownValue,
  isNumberValue,
  isTypeValue,
  isUnknownValue,
  type Value,
  valueToString,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluates __yo_array_fill builtin function
 * Syntax: __yo_array_fill(arrayType, fillValue)
 * - arrayType: Must be an ArrayType (checked with isArrayType)
 * - fillValue: Must be a compile-time known value ($.value !== undefined)
 *   with type matching the ArrayType's childType
 */
export function evaluateYoArrayFill({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}) {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_array_fill, 2);

  const arrayTypeArg = expr.args[0]!;
  const fillValueArg = expr.args[1]!;

  // Evaluate the array type argument
  const evaluatedArrayTypeArg = evaluateExpression({
    expr: arrayTypeArg,
    env,
    context: {
      ...context,
    },
  });

  if (evaluatedArrayTypeArg.$?.env) {
    env = evaluatedArrayTypeArg.$.env;
  }

  const arrayTypeValue = evaluatedArrayTypeArg.$?.value;

  // Check that the first argument is an ArrayType
  if (!isTypeValue(arrayTypeValue) || !isArrayType(arrayTypeValue.value)) {
    throw formatErrorMessage({
      token: arrayTypeArg.token,
      errorMessage: `__yo_array_fill expects first argument to be an ArrayType, got ${arrayTypeValue ? valueToString(arrayTypeValue) : "undefined"}`,
    });
  }

  const arrayType = arrayTypeValue.value;

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

  // Check that the fill value is compile-time known
  if (!fillValue) {
    throw formatErrorMessage({
      token: fillValueArg.token,
      errorMessage: `__yo_array_fill expects second argument to be a compile-time known value, got runtime value`,
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

  // Extract array length from the ArrayType
  const lengthValue = arrayType.length;

  // If the length is an UnknownValue, we can't create a concrete array at compile time
  if (isUnknownValue(lengthValue)) {
    const arrayValue = createUnknownValue(arrayType, { env, context });

    expr.$ = {
      env,
      type: arrayType,
      value: arrayValue,
      pathCollection: [],
    };

    return expr;
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

  // If fillValue is an UnknownValue, return an UnknownValue for the array
  if (isUnknownValue(fillValue)) {
    const arrayValue = createUnknownValue(arrayType, { env, context });

    expr.$ = {
      env,
      type: arrayType,
      value: arrayValue,
      pathCollection: [],
    };

    return expr;
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

  return expr;
}
