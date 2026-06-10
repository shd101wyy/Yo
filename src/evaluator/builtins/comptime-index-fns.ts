import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import type { Token } from "../../token";
import {
  createComptimeListType,
  createPtrType,
} from "../../types/creators";
import type {
  ArrayType,
  ComptimeListType,
  PtrType,
  Type,
} from "../../types/definitions";
import {
  isArrayType,
  isComptimeListType,
  isPtrType,
} from "../../types/guards";
import {
  createComptimeListValue,
  createComptimeStringValue,
  createUnknownValue,
  isArrayValue,
  isComptimeIntValue,
  isComptimeListValue,
  isComptimeStringValue,
  isNumberValue,
  isPtrValue,
  isStructValue,
  isUnknownValue,
  type ComptimeListValue,
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
 * Evaluate the comptime array element indexing builtin:
 * - __yo_comptime_array_index(self, idx)
 */
function evaluateComptimeElementIndex({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
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

  if (selfValue && isArrayValue(selfValue)) {
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
        comptimeRef: { kind: "array", arrayValue, index },
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
 * For *(Array(T, N)), returns *(T) (element pointer).
 * Falls back to the input type if it can't be determined.
 */
function computeElementReturnType(selfType: Type): Type {
  if (isPtrType(selfType)) {
    const pointee = (selfType as PtrType).childType;
    if (isArrayType(pointee)) {
      return createPtrType((pointee as ArrayType).childType);
    }
    if (isComptimeListType(pointee)) {
      return createPtrType((pointee as ComptimeListType).childType);
    }
  }
  if (isArrayType(selfType)) {
    return createPtrType((selfType as ArrayType).childType);
  }
  if (isComptimeListType(selfType)) {
    return createPtrType((selfType as ComptimeListType).childType);
  }
  return selfType;
}

/**
 * Evaluate comptime list element indexing builtin:
 * __yo_comptime_list_index(self, idx)
 *
 * Similar to __yo_comptime_array_index but for ComptimeList types.
 * Returns the element value with comptimeRef set for mutation support.
 */
function evaluateComptimeListIndex({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
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
      errorMessage: `Failed to evaluate self for comptime list index`,
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
      errorMessage: `Failed to evaluate index for comptime list index`,
    });
  }
  env = evaluatedIdx.$.env;

  const selfValue = evaluatedSelf.$.value;

  // Resolve ComptimeListValue: either directly or inside a PtrValue
  let listValue: ComptimeListValue | undefined;
  if (isComptimeListValue(selfValue)) {
    listValue = selfValue;
  } else if (
    selfValue &&
    isPtrValue(selfValue) &&
    isComptimeListValue(selfValue.targetValue[0])
  ) {
    listValue = selfValue.targetValue[0] as ComptimeListValue;
  }

  if (listValue) {
    const elementType = listValue.type.childType;

    if (evaluatedIdx.$.value && isNumberValue(evaluatedIdx.$.value)) {
      const index = extractIndex(evaluatedIdx.$.value.value);
      if (index < 0 || index >= listValue.elements.length) {
        throw formatErrorMessage({
          token: idxExpr.token,
          errorMessage: `ComptimeList index out of bounds: ${index}. Expected index in range [0, ${listValue.elements.length - 1}].`,
        });
      }
      const value = listValue.elements[index]!;

      expr.$ = {
        env,
        type: elementType,
        value,
        pathCollection: [],
        comptimeRef: { kind: "comptime_list", listValue, index },
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

  // Self is not a known comptime value — compute fallback type with UnknownValue
  const selfType = evaluatedSelf.$.type;
  const fallbackType = computeElementReturnType(selfType);
  expr.$ = {
    env,
    type: fallbackType,
    value: createUnknownValue(fallbackType, { env, context }),
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluate comptime list range indexing builtins:
 * - __yo_comptime_list_index_range(self, range)
 * - __yo_comptime_list_index_range_inclusive(self, range)
 *
 * Returns a new ComptimeList containing elements from the specified range.
 */
function evaluateComptimeListRangeIndex({
  expr,
  env,
  context,
  isInclusive,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
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
      errorMessage: `Failed to evaluate self for comptime list range index`,
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
      errorMessage: `Failed to evaluate range for comptime list range index`,
    });
  }
  env = evaluatedIdx.$.env;

  const selfValue = evaluatedSelf.$.value;
  const rangeValue = evaluatedIdx.$.value;

  // Range value is not a known comptime struct — return fallback
  if (!rangeValue || isUnknownValue(rangeValue) || !isStructValue(rangeValue)) {
    const selfType = evaluatedSelf.$.type;
    const fallbackType = computeListRangeReturnType(selfType);
    expr.$ = {
      env,
      type: fallbackType,
      value: createUnknownValue(fallbackType, { env, context }),
      pathCollection: [],
    };
    return expr;
  }

  const indices = extractRangeIndices(rangeValue, isInclusive);
  if (!indices) {
    throw formatErrorMessage({
      token: idxExpr.token,
      errorMessage: `Expected numeric start/end in Range for comptime list range index`,
    });
  }

  const { start: startIndex, end: endIndex } = indices;

  // Resolve ComptimeListValue: either directly or inside a PtrValue
  let listValue: ComptimeListValue | undefined;
  if (isComptimeListValue(selfValue)) {
    listValue = selfValue;
  } else if (
    selfValue &&
    isPtrValue(selfValue) &&
    isComptimeListValue(selfValue.targetValue[0])
  ) {
    listValue = selfValue.targetValue[0] as ComptimeListValue;
  }

  if (listValue) {
    const elementType = listValue.type.childType;
    const resultType = createComptimeListType(elementType);

    if (startIndex < 0 || startIndex > listValue.elements.length) {
      throw formatErrorMessage({
        token: idxExpr.token,
        errorMessage: `ComptimeList range start out of bounds: ${startIndex}. Expected in range [0, ${listValue.elements.length}].`,
      });
    }
    if (endIndex < startIndex || endIndex > listValue.elements.length) {
      throw formatErrorMessage({
        token: idxExpr.token,
        errorMessage: `ComptimeList range end out of bounds: ${endIndex}. Expected in range [${startIndex}, ${listValue.elements.length}].`,
      });
    }

    const slicedElements = listValue.elements.slice(startIndex, endIndex);
    const newListValue = createComptimeListValue(elementType, slicedElements);

    expr.$ = {
      env,
      type: resultType,
      value: newListValue,
      pathCollection: [],
    };
    return expr;
  }

  // Self is not a known comptime value — compute fallback type
  const selfType = evaluatedSelf.$.type;
  const fallbackType = computeListRangeReturnType(selfType);
  expr.$ = {
    env,
    type: fallbackType,
    value: createUnknownValue(fallbackType, { env, context }),
    pathCollection: [],
  };
  return expr;
}

/**
 * Compute the correct return type for ComptimeList range indexing.
 * For *(ComptimeList(T)), returns *(ComptimeList(T)).
 */
function computeListRangeReturnType(selfType: Type): Type {
  if (isPtrType(selfType)) {
    const pointee = (selfType as PtrType).childType;
    if (isComptimeListType(pointee)) {
      return createPtrType(pointee);
    }
  }
  if (isComptimeListType(selfType)) {
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
  // Normalize the result type to `*(comptime_string)` regardless of
  // how `self` was passed. Pre-inout, the trait took `comptime(self)
  // : *(Self)` so the input was already pointer-typed. With
  // `comptime(inout(self)) : Self`, the input is plain
  // `comptime_string`. The trait's return is `*(Self.Output)` in
  // both shapes — we always wrap here so the type matches.
  const inputType = evaluatedSelf.$.type;
  const baseType: Type = isPtrType(inputType)
    ? (inputType as PtrType).childType
    : inputType;
  const resultType: Type = createPtrType(baseType);

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
 * Dispatch function for all comptime array/string index builtins.
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
    return evaluateComptimeElementIndex({ expr, env, context });
  }
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_list_index)) {
    return evaluateComptimeListIndex({ expr, env, context });
  }
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_list_index_range)
  ) {
    return evaluateComptimeListRangeIndex({
      expr,
      env,
      context,
      isInclusive: false,
    });
  }
  if (
    exprIsFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_comptime_list_index_range_inclusive
    )
  ) {
    return evaluateComptimeListRangeIndex({
      expr,
      env,
      context,
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
