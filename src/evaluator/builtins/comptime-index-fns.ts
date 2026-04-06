import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import type { Token } from "../../token";
import { createPtrType, createSliceType } from "../../types/creators";
import type {
  ArrayType,
  ComptimeListType,
  PtrType,
  SliceType,
  Type,
} from "../../types/definitions";
import {
  isArrayType,
  isComptimeListType,
  isPtrType,
  isSliceType,
} from "../../types/guards";
import {
  createComptimeStringValue,
  createSliceValue,
  createUnknownValue,
  isArrayValue,
  isComptimeIntValue,
  isComptimeStringValue,
  isNumberValue,
  isSliceValue,
  isStructValue,
  isUnknownValue,
  type StructValue,
  type Value,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Extract a numeric index from a comptime value (number or bigint).
 */
function extractIndex(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * Extract start and end indices from a Range/RangeInclusive struct value.
 * Range is struct(start: T, end: T) so fields[0] = start, fields[1] = end.
 */
function extractRangeIndices(
  rangeValue: StructValue,
  isInclusive: boolean
): { start: number; end: number } | undefined {
  const startField = rangeValue.fields[0];
  const endField = rangeValue.fields[1];
  if (!startField || !endField) return undefined;
  if (!isNumberValue(startField) || !isNumberValue(endField)) return undefined;

  const start = extractIndex(startField.value);
  let end = extractIndex(endField.value);
  if (isInclusive) end += 1;

  return { start, end };
}

/**
 * Evaluate comptime array/slice element indexing builtins:
 * - __yo_comptime_array_index(self, idx)
 * - __yo_comptime_slice_index(self, idx)
 */
function evaluateComptimeElementIndex({
  expr,
  env,
  context,
  isSlice,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  isSlice: boolean;
}): FnCallExpr {
  const selfExpr = expr.args[0]!;
  const idxExpr = expr.args[1]!;

  const evaluatedSelf = evaluateExpression({
    expr: selfExpr,
    env,
    context: { ...context },
  });
  if (!evaluatedSelf.$) {
    throw formatErrorMessage({
      token: selfExpr.token,
      errorMessage: `Failed to evaluate self for comptime index`,
    });
  }
  env = evaluatedSelf.$.env;

  const evaluatedIdx = evaluateExpression({
    expr: idxExpr,
    env,
    context: { ...context },
  });
  if (!evaluatedIdx.$) {
    throw formatErrorMessage({
      token: idxExpr.token,
      errorMessage: `Failed to evaluate index for comptime index`,
    });
  }
  env = evaluatedIdx.$.env;

  const selfValue = evaluatedSelf.$.value;

  if (isSlice && selfValue && isSliceValue(selfValue)) {
    const sliceValue = selfValue;
    const elementType = (sliceValue.type as SliceType).childType;

    if (evaluatedIdx.$.value && isNumberValue(evaluatedIdx.$.value)) {
      const relativeIndex = extractIndex(evaluatedIdx.$.value.value);
      const sliceLength = sliceValue.endIndex - sliceValue.startIndex;
      if (relativeIndex < 0 || relativeIndex >= sliceLength) {
        throw formatErrorMessage({
          token: idxExpr.token,
          errorMessage: `Slice index out of bounds: ${relativeIndex}. Expected index in range [0, ${sliceLength - 1}].`,
        });
      }
      const absoluteIndex = sliceValue.startIndex + relativeIndex;
      const sourceArray = sliceValue.sourceArray[0]!;
      const value = sourceArray.elements[absoluteIndex]!;

      expr.$ = {
        env,
        type: elementType,
        value,
        pathCollection: [],
        arrayElementRef: { arrayValue: sourceArray, index: absoluteIndex },
      };
      return expr;
    }

    // Unknown index — return unknown value
    expr.$ = {
      env,
      type: elementType,
      value: createUnknownValue(elementType, { env, context }),
      pathCollection: [],
    };
    return expr;
  }

  if (!isSlice && selfValue && isArrayValue(selfValue)) {
    const arrayValue = selfValue;
    const elementType = (arrayValue.type as ArrayType).childType;

    if (evaluatedIdx.$.value && isNumberValue(evaluatedIdx.$.value)) {
      const index = extractIndex(evaluatedIdx.$.value.value);
      if (index < 0 || index >= arrayValue.elements.length) {
        throw formatErrorMessage({
          token: idxExpr.token,
          errorMessage: `Array index out of bounds: ${index}. Expected index in range [0, ${arrayValue.elements.length - 1}].`,
        });
      }
      const value = arrayValue.elements[index]!;

      expr.$ = {
        env,
        type: elementType,
        value,
        pathCollection: [],
        arrayElementRef: { arrayValue, index },
      };
      return expr;
    }

    // Unknown index — return unknown value
    expr.$ = {
      env,
      type: elementType,
      value: createUnknownValue(elementType, { env, context }),
      pathCollection: [],
    };
    return expr;
  }

  // Self is not a known comptime value (e.g., during generic impl evaluation)
  // Compute correct return type: element type for element indexing
  const selfType = evaluatedSelf.$.type;
  const fallbackType = computeElementReturnType(selfType);
  expr.$ = {
    env,
    type: fallbackType,
    value: undefined,
    pathCollection: [],
  };
  return expr;
}

/**
 * Compute the correct return type for element indexing.
 * For *(Array(T, N)) or *(Slice(T)), returns *(T) (element pointer).
 * Falls back to the input type if it can't be determined.
 */
function computeElementReturnType(selfType: Type): Type {
  if (isPtrType(selfType)) {
    const pointee = (selfType as PtrType).childType;
    if (isArrayType(pointee)) {
      return createPtrType((pointee as ArrayType).childType);
    }
    if (isSliceType(pointee)) {
      return createPtrType((pointee as SliceType).childType);
    }
    if (isComptimeListType(pointee)) {
      return createPtrType((pointee as ComptimeListType).childType);
    }
  }
  if (isArrayType(selfType)) {
    return createPtrType((selfType as ArrayType).childType);
  }
  if (isSliceType(selfType)) {
    return createPtrType((selfType as SliceType).childType);
  }
  if (isComptimeListType(selfType)) {
    return createPtrType((selfType as ComptimeListType).childType);
  }
  return selfType;
}

/**
 * Evaluate comptime array/slice range indexing builtins:
 * - __yo_comptime_array_index_range(self, range)
 * - __yo_comptime_array_index_range_inclusive(self, range)
 * - __yo_comptime_slice_index_range(self, range)
 * - __yo_comptime_slice_index_range_inclusive(self, range)
 *
 * Range is struct(start: T, end: T), fields[0] = start, fields[1] = end.
 */
function evaluateComptimeRangeIndex({
  expr,
  env,
  context,
  isSlice,
  isInclusive,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  isSlice: boolean;
  isInclusive: boolean;
}): FnCallExpr {
  const selfExpr = expr.args[0]!;
  const idxExpr = expr.args[1]!;

  const evaluatedSelf = evaluateExpression({
    expr: selfExpr,
    env,
    context: { ...context },
  });
  if (!evaluatedSelf.$) {
    throw formatErrorMessage({
      token: selfExpr.token,
      errorMessage: `Failed to evaluate self for comptime range index`,
    });
  }
  env = evaluatedSelf.$.env;

  const evaluatedIdx = evaluateExpression({
    expr: idxExpr,
    env,
    context: { ...context },
  });
  if (!evaluatedIdx.$) {
    throw formatErrorMessage({
      token: idxExpr.token,
      errorMessage: `Failed to evaluate range index for comptime index`,
    });
  }
  env = evaluatedIdx.$.env;

  const selfValue = evaluatedSelf.$.value;
  const rangeValue = evaluatedIdx.$.value;

  // Range value is not a known comptime struct (e.g., runtime range, or
  // UnknownValue during generic impl specialization) — return fallback
  // The return type for range indexing is always *(Slice(childType))
  if (!rangeValue || isUnknownValue(rangeValue) || !isStructValue(rangeValue)) {
    const selfType = evaluatedSelf.$.type;
    const fallbackType = computeRangeReturnType(selfType);
    expr.$ = {
      env,
      type: fallbackType,
      value: undefined,
      pathCollection: [],
    };
    return expr;
  }

  const indices = extractRangeIndices(rangeValue, isInclusive);
  if (!indices) {
    throw formatErrorMessage({
      token: idxExpr.token,
      errorMessage: `Expected numeric start/end in Range for comptime range index`,
    });
  }

  const { start: startIndex, end: endIndex } = indices;

  if (!isSlice && selfValue && isArrayValue(selfValue)) {
    const arrayValue = selfValue;
    const elementType = (arrayValue.type as ArrayType).childType;
    const resultSliceType = createSliceType(elementType);

    if (startIndex < 0 || startIndex > arrayValue.elements.length) {
      throw formatErrorMessage({
        token: idxExpr.token,
        errorMessage: `Slice start index out of bounds: ${startIndex}. Expected index in range [0, ${arrayValue.elements.length}].`,
      });
    }
    if (endIndex < startIndex || endIndex > arrayValue.elements.length) {
      throw formatErrorMessage({
        token: idxExpr.token,
        errorMessage: `Slice end index out of bounds: ${endIndex}. Expected index in range [${startIndex}, ${arrayValue.elements.length}].`,
      });
    }

    const newSliceValue = createSliceValue(
      resultSliceType,
      [arrayValue],
      startIndex,
      endIndex
    );
    expr.$ = {
      env,
      type: resultSliceType,
      value: newSliceValue,
      pathCollection: [],
    };
    return expr;
  }

  if (isSlice && selfValue && isSliceValue(selfValue)) {
    const sliceValue = selfValue;
    const elementType = (sliceValue.type as SliceType).childType;
    const resultSliceType = createSliceType(elementType);
    const sliceLength = sliceValue.endIndex - sliceValue.startIndex;

    if (startIndex < 0 || startIndex > sliceLength) {
      throw formatErrorMessage({
        token: idxExpr.token,
        errorMessage: `Slice start index out of bounds: ${startIndex}. Expected index in range [0, ${sliceLength}].`,
      });
    }
    if (endIndex < startIndex || endIndex > sliceLength) {
      throw formatErrorMessage({
        token: idxExpr.token,
        errorMessage: `Slice end index out of bounds: ${endIndex}. Expected index in range [${startIndex}, ${sliceLength}].`,
      });
    }

    const absoluteStart = sliceValue.startIndex + startIndex;
    const absoluteEnd = sliceValue.startIndex + endIndex;

    const newSliceValue = createSliceValue(
      resultSliceType,
      sliceValue.sourceArray,
      absoluteStart,
      absoluteEnd
    );
    expr.$ = {
      env,
      type: resultSliceType,
      value: newSliceValue,
      pathCollection: [],
    };
    return expr;
  }

  // Self is not a known comptime value (e.g., during generic impl evaluation)
  // For range indexing, return *(Slice(childType))
  const selfType = evaluatedSelf.$.type;
  const fallbackType = computeRangeReturnType(selfType);
  expr.$ = {
    env,
    type: fallbackType,
    value: undefined,
    pathCollection: [],
  };
  return expr;
}

/**
 * Compute the correct return type for range indexing.
 * For *(Array(T, N)) or *(Slice(T)), returns *(Slice(T)).
 * Falls back to the input type if it can't be determined.
 */
function computeRangeReturnType(selfType: Type): Type {
  // Self is a pointer to array or slice: *(Array(T,N)) or *(Slice(T))
  if (isPtrType(selfType)) {
    const pointee = (selfType as PtrType).childType;
    if (isArrayType(pointee)) {
      const elementType = (pointee as ArrayType).childType;
      return createPtrType(createSliceType(elementType));
    }
    if (isSliceType(pointee)) {
      // Slice range index returns same slice type
      return selfType;
    }
  }
  // Array or slice directly (without pointer wrapper)
  if (isArrayType(selfType)) {
    const elementType = (selfType as ArrayType).childType;
    return createPtrType(createSliceType(elementType));
  }
  if (isSliceType(selfType)) {
    return createPtrType(selfType);
  }
  return selfType;
}

/**
 * Evaluate comptime string indexing builtins:
 * - __yo_comptime_string_index(self, idx)
 * - __yo_comptime_string_index_range(self, range)
 * - __yo_comptime_string_index_range_inclusive(self, range)
 */
function evaluateComptimeStringIndex({
  expr,
  env,
  context,
  isRange,
  isInclusive,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  isRange: boolean;
  isInclusive: boolean;
}): FnCallExpr {
  const selfExpr = expr.args[0]!;
  const idxExpr = expr.args[1]!;

  const evaluatedSelf = evaluateExpression({
    expr: selfExpr,
    env,
    context: { ...context },
  });
  if (!evaluatedSelf.$) {
    throw formatErrorMessage({
      token: selfExpr.token,
      errorMessage: `Failed to evaluate self for comptime string index`,
    });
  }
  env = evaluatedSelf.$.env;

  const evaluatedIdx = evaluateExpression({
    expr: idxExpr,
    env,
    context: { ...context },
  });
  if (!evaluatedIdx.$) {
    throw formatErrorMessage({
      token: idxExpr.token,
      errorMessage: `Failed to evaluate index for comptime string index`,
    });
  }
  env = evaluatedIdx.$.env;

  const selfValue = evaluatedSelf.$.value;
  const resultType = evaluatedSelf.$.type;

  if (!selfValue || !isComptimeStringValue(selfValue)) {
    // Unknown value (e.g., during impl evaluation with SomeType params)
    expr.$ = {
      env,
      type: resultType,
      value: undefined,
      pathCollection: [],
    };
    return expr;
  }

  const str = selfValue.value;

  if (!isRange) {
    // Single character index
    const idxValue = evaluatedIdx.$.value;
    if (
      !idxValue ||
      isUnknownValue(idxValue) ||
      !isComptimeIntValue(idxValue)
    ) {
      // Runtime or unknown index — return placeholder
      expr.$ = {
        env,
        type: resultType,
        value: undefined,
        pathCollection: [],
      };
      return expr;
    }

    const index = extractIndex(idxValue.value);
    if (index < 0 || index >= str.length) {
      throw formatErrorMessage({
        token: idxExpr.token,
        errorMessage: `String index out of bounds: ${index}. Expected index in range [0, ${str.length - 1}].`,
      });
    }

    expr.$ = {
      env,
      type: resultType,
      value: createComptimeStringValue(str[index]!),
      pathCollection: [],
    };
    return expr;
  }

  // Range index
  const rangeValue = evaluatedIdx.$.value;
  if (!rangeValue || isUnknownValue(rangeValue) || !isStructValue(rangeValue)) {
    // Runtime or unknown range value — return placeholder
    expr.$ = {
      env,
      type: resultType,
      value: undefined,
      pathCollection: [],
    };
    return expr;
  }

  const indices = extractRangeIndices(rangeValue, isInclusive);
  if (!indices) {
    throw formatErrorMessage({
      token: idxExpr.token,
      errorMessage: `Expected numeric start/end in Range for comptime string range index`,
    });
  }

  const { start: startIndex, end: endIndex } = indices;

  if (startIndex < 0 || startIndex > str.length) {
    throw formatErrorMessage({
      token: idxExpr.token,
      errorMessage: `String slice start index out of bounds: ${startIndex}. Expected index in range [0, ${str.length}].`,
    });
  }
  if (endIndex < startIndex || endIndex > str.length) {
    throw formatErrorMessage({
      token: idxExpr.token,
      errorMessage: `String slice end index out of bounds: ${endIndex}. Expected index in range [${startIndex}, ${str.length}].`,
    });
  }

  expr.$ = {
    env,
    type: resultType,
    value: createComptimeStringValue(str.slice(startIndex, endIndex)),
    pathCollection: [],
  };
  return expr;
}

/**
 * Dispatch function for all comptime array/slice/string index builtins.
 */
export function evaluateYoComptimeIndexFunctions({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_array_index)) {
    return evaluateComptimeElementIndex({ expr, env, context, isSlice: false });
  }
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_slice_index)) {
    return evaluateComptimeElementIndex({ expr, env, context, isSlice: true });
  }
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_array_index_range)
  ) {
    return evaluateComptimeRangeIndex({
      expr,
      env,
      context,
      isSlice: false,
      isInclusive: false,
    });
  }
  if (
    exprIsFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_comptime_array_index_range_inclusive
    )
  ) {
    return evaluateComptimeRangeIndex({
      expr,
      env,
      context,
      isSlice: false,
      isInclusive: true,
    });
  }
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_slice_index_range)
  ) {
    return evaluateComptimeRangeIndex({
      expr,
      env,
      context,
      isSlice: true,
      isInclusive: false,
    });
  }
  if (
    exprIsFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_comptime_slice_index_range_inclusive
    )
  ) {
    return evaluateComptimeRangeIndex({
      expr,
      env,
      context,
      isSlice: true,
      isInclusive: true,
    });
  }
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_index)) {
    return evaluateComptimeStringIndex({
      expr,
      env,
      context,
      isRange: false,
      isInclusive: false,
    });
  }
  if (
    exprIsFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_comptime_string_index_range
    )
  ) {
    return evaluateComptimeStringIndex({
      expr,
      env,
      context,
      isRange: true,
      isInclusive: false,
    });
  }
  if (
    exprIsFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_comptime_string_index_range_inclusive
    )
  ) {
    return evaluateComptimeStringIndex({
      expr,
      env,
      context,
      isRange: true,
      isInclusive: true,
    });
  }

  throw formatErrorMessage({
    token: expr.token,
    errorMessage: `Unexpected comptime index builtin: ${exprToString(expr)}`,
  });
}

/**
 * Handle comptime_string indexing directly with pre-evaluated values.
 * Called from the function dispatch for `comptime_string_value(arg)`.
 *
 * @param strValue - The JavaScript string from the ComptimeStringValue
 * @param argValue - The evaluated argument value (comptime_int or Range struct)
 * @param argType - The evaluated argument type
 * @param token - Token for error messages
 * @param isRange - Whether this is a range index
 * @param isInclusive - Whether this is an inclusive range
 * @returns The result comptime_string value
 */
export function computeComptimeStringIndex({
  strValue,
  argValue,
  token,
  isRange,
  isInclusive,
}: {
  strValue: string;
  argValue: Value;
  token: Token;
  isRange: boolean;
  isInclusive: boolean;
}): Value {
  // During checking phase, argValue may be UnknownValue — return a placeholder
  if (isUnknownValue(argValue)) {
    return createComptimeStringValue("");
  }

  if (!isRange) {
    if (!isComptimeIntValue(argValue)) {
      throw formatErrorMessage({
        token,
        errorMessage: `Expected comptime_int index for comptime string index`,
      });
    }
    const index = extractIndex(argValue.value);
    if (index < 0 || index >= strValue.length) {
      throw formatErrorMessage({
        token,
        errorMessage: `String index out of bounds: ${index}. Expected index in range [0, ${strValue.length - 1}].`,
      });
    }
    return createComptimeStringValue(strValue[index]!);
  }

  // Range index
  if (!isStructValue(argValue)) {
    throw formatErrorMessage({
      token,
      errorMessage: `Expected comptime Range value for comptime string range index`,
    });
  }

  const indices = extractRangeIndices(argValue, isInclusive);
  if (!indices) {
    throw formatErrorMessage({
      token,
      errorMessage: `Expected numeric start/end in Range for comptime string range index`,
    });
  }

  const { start: startIndex, end: endIndex } = indices;

  if (startIndex < 0 || startIndex > strValue.length) {
    throw formatErrorMessage({
      token,
      errorMessage: `String slice start index out of bounds: ${startIndex}. Expected index in range [0, ${strValue.length}].`,
    });
  }
  if (endIndex < startIndex || endIndex > strValue.length) {
    throw formatErrorMessage({
      token,
      errorMessage: `String slice end index out of bounds: ${endIndex}. Expected index in range [${startIndex}, ${strValue.length}].`,
    });
  }

  return createComptimeStringValue(strValue.slice(startIndex, endIndex));
}
