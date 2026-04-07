import type { Environment } from "../../env";
import { getVariablesFromEnv } from "../../env";
import { formatErrorMessage } from "../../error";
import type { Expr } from "../../expr";
import { exprToString } from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import {
  createPtrType,
  createSliceType,
  createUsizeType,
} from "../../types/creators";
import type {
  ArrayType,
  SliceType,
  StructType,
  Type,
} from "../../types/definitions";
import { isFunctionType, isStructType } from "../../types/guards";
import { convertComptimeTypeToRuntimeType } from "../../types/utils";
import {
  createSliceValue,
  createTypeValue,
  createUnknownValue,
  isFunctionValue,
  isNumberValue,
  isStructValue,
  isTypeValue,
  type ArrayValue,
  type SliceValue,
  type Value,
} from "../../value";
import type { EvaluatorContext, IndexCallResult } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { evaluateComptimeFunctionCall } from "./comptime-fn";
import { computeComptimeStringIndex } from "../builtins/comptime-index-fns";

/**
 * Resolves a prelude type constructor (like Range or RangeInclusive) applied to usize.
 * Looks up the constructor by name from env, calls it with usize, returns the result type.
 */
function resolvePreludeTypeWithUsize(
  name: string,
  env: Environment,
  context: EvaluatorContext
): StructType | undefined {
  const variables = getVariablesFromEnv(env, name);
  const variable = variables.find(
    (v) => v.value?.[0] && isFunctionValue(v.value[0]) && isFunctionType(v.type)
  );
  if (
    !variable ||
    !variable.value?.[0] ||
    !isFunctionValue(variable.value[0])
  ) {
    return undefined;
  }

  const funcValue = variable.value[0];
  const funcType = funcValue.type;
  const usizeTypeValue = createTypeValue(createUsizeType());

  try {
    const { value: resultValue } = evaluateComptimeFunctionCall({
      functionCalleeExpr: undefined,
      functionType: funcType,
      functionValue: funcValue,
      argValues: {
        forallArgs: [],
        args: [
          {
            value: usizeTypeValue,
            parameterType: funcType.parameters[0]!.type,
            argType: usizeTypeValue.type,
          },
        ],
        variadicArgs: [],
      },
      callerEnv: env,
      calleeEnv: env,
      context,
    });

    if (isTypeValue(resultValue) && isStructType(resultValue.value)) {
      return resultValue.value;
    }
  } catch {
    // If type constructor call fails, return undefined
  }
  return undefined;
}

// Cache Range(usize) and RangeInclusive(usize) lookups per compilation.
// Keyed on the first env frame to avoid stale cache across compilations.
const rangeTypeCache = new WeakMap<
  object,
  { range: StructType | undefined; rangeInclusive: StructType | undefined }
>();

function getCachedRangeTypes(
  env: Environment,
  context: EvaluatorContext
): { range: StructType | undefined; rangeInclusive: StructType | undefined } {
  const key = env.frames[0]!;
  let cached = rangeTypeCache.get(key);
  if (!cached) {
    cached = {
      range: resolvePreludeTypeWithUsize("Range", env, context),
      rangeInclusive: resolvePreludeTypeWithUsize(
        "RangeInclusive",
        env,
        context
      ),
    };
    rangeTypeCache.set(key, cached);
  }
  return cached;
}

/**
 * Checks whether `argType` is compatible with Range(usize) or RangeInclusive(usize).
 * Returns { isRange: true, isInclusive: boolean } or { isRange: false }.
 */
export function checkRangeType(
  argType: Type,
  env: Environment,
  context: EvaluatorContext
): { isRange: boolean; isInclusive: boolean } {
  if (!isStructType(argType)) {
    return { isRange: false, isInclusive: false };
  }

  const { range: rangeType, rangeInclusive: rangeInclusiveType } =
    getCachedRangeTypes(env, context);

  if (
    rangeInclusiveType &&
    areTypesCompatible(
      { type: rangeInclusiveType, env },
      { type: argType, env }
    )
  ) {
    return { isRange: true, isInclusive: true };
  }

  if (
    rangeType &&
    areTypesCompatible({ type: rangeType, env }, { type: argType, env })
  ) {
    return { isRange: true, isInclusive: false };
  }

  return { isRange: false, isInclusive: false };
}

/**
 * Tries to perform comptime array/slice indexing (element access or range slicing).
 * Returns an IndexCallResult if successful, or undefined to fall through to Index trait dispatch.
 */
export function tryComptimeArraySliceIndex({
  argExpr,
  arrayValue,
  sliceValue,
  arrayType,
  env,
  context,
}: {
  argExpr: Expr;
  arrayValue: ArrayValue | undefined;
  sliceValue: SliceValue | undefined;
  arrayType: ArrayType | SliceType;
  env: Environment;
  context: EvaluatorContext;
}): IndexCallResult | undefined {
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
      expectedType: undefined,
    },
  });
  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate argument expression:\n${exprToString(argExpr)}`,
    });
  }
  const callerEnv = evaluatedArgExpr.$.env;
  const argType = evaluatedArgExpr.$.type;
  const argValue = evaluatedArgExpr.$.value;

  const { isRange, isInclusive } = checkRangeType(argType, env, context);

  if (isRange) {
    return tryComptimeRangeSlicing({
      argExpr,
      argValue,
      isInclusive,
      arrayValue,
      sliceValue,
      arrayType,
      callerEnv,
    });
  }

  // Single element access with comptime index
  return tryComptimeElementAccess({
    argExpr,
    argValue,
    arrayValue,
    sliceValue,
    arrayType,
    callerEnv,
    context,
  });
}

function tryComptimeRangeSlicing({
  argExpr,
  argValue,
  isInclusive,
  arrayValue,
  sliceValue,
  arrayType,
  callerEnv,
}: {
  argExpr: Expr;
  argValue: Value | undefined;
  isInclusive: boolean;
  arrayValue: ArrayValue | undefined;
  sliceValue: SliceValue | undefined;
  arrayType: ArrayType | SliceType;
  callerEnv: Environment;
}): IndexCallResult | undefined {
  const sliceType = createSliceType(arrayType.childType);

  if (!isStructValue(argValue)) {
    return undefined; // Runtime range — fall through to Index trait
  }

  const startVal = argValue.fields[0];
  const endVal = argValue.fields[1];

  if (
    !startVal ||
    !endVal ||
    !isNumberValue(startVal) ||
    !isNumberValue(endVal)
  ) {
    return undefined; // Runtime values in range — fall through
  }

  const startValue = startVal.value;
  const endValue = endVal.value;
  const startIndex =
    typeof startValue === "bigint" ? Number(startValue) : startValue;
  const endIndex =
    (typeof endValue === "bigint" ? Number(endValue) : endValue) +
    (isInclusive ? 1 : 0);

  if (arrayValue) {
    if (startIndex < 0 || startIndex > arrayValue.elements.length) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Slice start index out of bounds: ${startIndex}. Expected index in range [0, ${arrayValue.elements.length}].`,
      });
    }
    if (endIndex < startIndex || endIndex > arrayValue.elements.length) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Slice end index out of bounds: ${endIndex}. Expected index in range [${startIndex}, ${arrayValue.elements.length}].`,
      });
    }
    const newSliceValue = createSliceValue(
      sliceType,
      [arrayValue],
      startIndex,
      endIndex
    );
    return {
      value: newSliceValue,
      type: sliceType,
      ptrType: createPtrType(sliceType),
      indexMethodType: undefined,
      indexMethodValue: undefined,
      callerEnv,
    };
  }

  if (sliceValue) {
    const sliceLength = sliceValue.endIndex - sliceValue.startIndex;
    if (startIndex < 0 || startIndex > sliceLength) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Slice start index out of bounds: ${startIndex}. Expected index in range [0, ${sliceLength}].`,
      });
    }
    if (endIndex < startIndex || endIndex > sliceLength) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Slice end index out of bounds: ${endIndex}. Expected index in range [${startIndex}, ${sliceLength}].`,
      });
    }
    const absoluteStart = sliceValue.startIndex + startIndex;
    const absoluteEnd = sliceValue.startIndex + endIndex;
    const newSliceValue = createSliceValue(
      sliceType,
      sliceValue.sourceArray,
      absoluteStart,
      absoluteEnd
    );
    return {
      value: newSliceValue,
      type: sliceType,
      ptrType: createPtrType(sliceType),
      indexMethodType: undefined,
      indexMethodValue: undefined,
      callerEnv,
    };
  }

  return undefined;
}

function tryComptimeElementAccess({
  argExpr,
  argValue,
  arrayValue,
  sliceValue,
  arrayType,
  callerEnv,
  context,
}: {
  argExpr: Expr;
  argValue: Value | undefined;
  arrayValue: ArrayValue | undefined;
  sliceValue: SliceValue | undefined;
  arrayType: ArrayType | SliceType;
  callerEnv: Environment;
  context: EvaluatorContext;
}): IndexCallResult | undefined {
  const returnType = arrayType.childType;

  if (isNumberValue(argValue)) {
    const indexValue = argValue.value;
    const index =
      typeof indexValue === "bigint" ? Number(indexValue) : indexValue;

    if (arrayValue) {
      if (index < 0 || index >= arrayValue.elements.length) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Array index out of bounds: ${index}. Expected index in range [0, ${arrayValue.elements.length - 1}].`,
        });
      }
      const elementValue = arrayValue.elements[index]!;
      const arrayElementRef = { arrayValue, index };
      return {
        value: elementValue,
        type: returnType,
        ptrType: createPtrType(returnType),
        indexMethodType: undefined,
        indexMethodValue: undefined,
        callerEnv,
        index,
        arrayElementRef,
      };
    }

    if (sliceValue) {
      const sliceLength = sliceValue.endIndex - sliceValue.startIndex;
      if (index < 0 || index >= sliceLength) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Slice index out of bounds: ${index}. Expected index in range [0, ${sliceLength - 1}].`,
        });
      }
      const absoluteIndex = sliceValue.startIndex + index;
      const sourceArray = sliceValue.sourceArray[0]!;
      const elementValue = sourceArray.elements[absoluteIndex]!;
      const arrayElementRef = {
        arrayValue: sourceArray,
        index: absoluteIndex,
      };
      return {
        value: elementValue,
        type: returnType,
        ptrType: createPtrType(returnType),
        indexMethodType: undefined,
        indexMethodValue: undefined,
        callerEnv,
        index,
        arrayElementRef,
      };
    }
  } else if (!argValue) {
    // Runtime index into comptime array/slice: convert to runtime type
    return {
      value: undefined,
      type: convertComptimeTypeToRuntimeType({
        type: returnType,
        env: callerEnv,
      }),
      ptrType: createPtrType(returnType),
      indexMethodType: undefined,
      indexMethodValue: undefined,
      callerEnv,
    };
  } else {
    // Unknown comptime value (e.g., UnknownValue)
    const unknownValue = createUnknownValue(returnType, {
      env: callerEnv,
      context,
    });
    return {
      value: unknownValue,
      type: returnType,
      ptrType: createPtrType(returnType),
      indexMethodType: undefined,
      indexMethodValue: undefined,
      callerEnv,
    };
  }

  return undefined;
}

/**
 * Tries to perform comptime_string indexing: "hello"(0), "hello"(0..3), etc.
 * Returns an IndexCallResult if successful, throws on error.
 */
export function tryComptimeStringIndex({
  argExpr,
  strValue,
  env,
  context,
}: {
  argExpr: Expr;
  strValue: string;
  env: Environment;
  context: EvaluatorContext;
}): IndexCallResult {
  const evaluatedArg = evaluateExpression({
    expr: argExpr,
    env,
    context: { ...context, expectedType: undefined },
  });
  if (!evaluatedArg.$ || !evaluatedArg.$.value) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate index argument for comptime string indexing`,
    });
  }
  const argType = evaluatedArg.$.type;
  const argValue = evaluatedArg.$.value;
  const callerEnv = evaluatedArg.$.env;

  const { isRange, isInclusive } = checkRangeType(argType, env, context);

  const resultValue = computeComptimeStringIndex({
    strValue,
    argValue,
    token: argExpr.token,
    isRange,
    isInclusive,
  });

  const resultType = resultValue.type;
  const ptrResultType = createPtrType(resultType);

  return {
    value: resultValue,
    type: resultType,
    ptrType: ptrResultType,
    indexMethodType: undefined,
    indexMethodValue: undefined,
    callerEnv,
  };
}
