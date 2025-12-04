import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  Expr,
  ExprTag,
  exprToString,
  FuncCallExpr,
  replaceExprWithFuncCallExpr,
} from "../../expr";
import { TokenType } from "../../token";
import {
  isCCompatibleType,
  isComptFloatType,
  isComptIntType,
  isFloatType,
  isIntegerType,
  Type,
  TypeTag,
  typeToString,
} from "../../types";
import {
  createComptFloatValue,
  createComptIntValue,
  createNumberValue,
  createUnknownValue,
  isComptFloatValue,
  isComptIntValue,
  isNumberValue,
  NumberValue,
  Value,
} from "../../value";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Get the numeric bounds for a type.
 * Returns [min, max] for the type, or undefined if the type has no fixed bounds.
 */
function getNumericBounds(
  type: Type
): { min: number; max: number } | undefined {
  switch (type.tag) {
    case TypeTag.U8:
      return { min: 0, max: 255 };
    case TypeTag.I8:
      return { min: -128, max: 127 };
    case TypeTag.U16:
      return { min: 0, max: 65535 };
    case TypeTag.I16:
      return { min: -32768, max: 32767 };
    case TypeTag.U32:
      return { min: 0, max: 4294967295 };
    case TypeTag.I32:
      return { min: -2147483648, max: 2147483647 };
    case TypeTag.U64:
      return { min: 0, max: Number.MAX_SAFE_INTEGER }; // JS limitation
    case TypeTag.I64:
      return { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }; // JS limitation
    case TypeTag.Usize:
      return { min: 0, max: Number.MAX_SAFE_INTEGER }; // JS limitation
    case TypeTag.Isize:
      return { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }; // JS limitation
    case TypeTag.F32:
    case TypeTag.F64:
      return undefined; // No fixed bounds for floats
    default:
      return undefined;
  }
}

/**
 * Get the ValueTag for a numeric type.
 */
function getValueTagFromType(type: Type): ValueTag | undefined {
  switch (type.tag) {
    case TypeTag.U8:
      return ValueTag.U8;
    case TypeTag.I8:
      return ValueTag.I8;
    case TypeTag.U16:
      return ValueTag.U16;
    case TypeTag.I16:
      return ValueTag.I16;
    case TypeTag.U32:
      return ValueTag.U32;
    case TypeTag.I32:
      return ValueTag.I32;
    case TypeTag.U64:
      return ValueTag.U64;
    case TypeTag.I64:
      return ValueTag.I64;
    case TypeTag.Usize:
      return ValueTag.Usize;
    case TypeTag.Isize:
      return ValueTag.Isize;
    case TypeTag.F32:
      return ValueTag.F32;
    case TypeTag.F64:
      return ValueTag.F64;
    default:
      return undefined;
  }
}

/**
 * Check if a type supports compile-time values.
 */
function supportsComptValue(type: Type): boolean {
  return (
    isIntegerType(type) ||
    isFloatType(type) ||
    isComptIntType(type) ||
    isComptFloatType(type)
  );
}

/**
 * Check if a type is a convertible numeric type.
 * This includes all numeric types that can be used with type(value) syntax.
 */
export function isConvertibleNumericType(type: Type): boolean {
  return (
    isIntegerType(type) ||
    isFloatType(type) ||
    isComptIntType(type) ||
    isComptFloatType(type) ||
    isCCompatibleType(type)
  );
}

/**
 * Extract numeric value from a Value if it's compile-time known.
 */
function extractComptNumericValue(value?: Value): number | undefined {
  if (!value) return undefined;
  // isNumberValue includes ComptInt, ComptFloat, and all concrete numeric types
  if (isNumberValue(value)) {
    return value.value;
  }
  return undefined;
}

/**
 * Check if a value is compile-time known.
 */
function isComptValue(value?: Value): boolean {
  return (
    isComptIntValue(value) || isComptFloatValue(value) || isNumberValue(value)
  );
}

/**
 * Create a compile-time value of the target type.
 */
function createComptValueOfType(
  numericValue: number,
  targetType: Type,
  errorToken: Expr["token"]
): Value {
  // Check bounds for integer types at compile time
  const bounds = getNumericBounds(targetType);
  if (bounds) {
    if (numericValue < bounds.min || numericValue > bounds.max) {
      throw formatErrorMessage({
        token: errorToken,
        errorMessage: `Value ${numericValue} is out of range for type ${typeToString(targetType)} (${bounds.min} to ${bounds.max})`,
      });
    }
  }

  // Create the appropriate value type
  if (isComptIntType(targetType)) {
    return createComptIntValue(Math.floor(numericValue));
  }
  if (isComptFloatType(targetType)) {
    return createComptFloatValue(numericValue);
  }
  if (isFloatType(targetType)) {
    const tag = getValueTagFromType(targetType);
    if (tag) {
      return createNumberValue(tag as NumberValue["tag"], numericValue);
    }
  }
  if (isIntegerType(targetType)) {
    const tag = getValueTagFromType(targetType);
    if (tag) {
      return createNumberValue(
        tag as NumberValue["tag"],
        Math.floor(numericValue)
      );
    }
  }

  throw formatErrorMessage({
    token: errorToken,
    errorMessage: `Cannot create compile-time value for type ${typeToString(targetType)}`,
  });
}

/**
 * Try to convert a value to a numeric type.
 * Returns the result if successful, or undefined if this is not a numeric type call.
 */
export function tryToConvertToNumericType({
  targetType,
  argExpr,
  expr,
  callerEnv,
  context,
}: {
  targetType: Type;
  argExpr: Expr;
  expr: FuncCallExpr;
  callerEnv: Environment;
  context: EvaluatorContext;
}): { expr: Expr; env: Environment } | undefined {
  if (!isConvertibleNumericType(targetType)) {
    return undefined;
  }

  // Evaluate the argument
  // Clear expectedType to allow the argument to be evaluated with its natural type
  // The type conversion will happen after evaluation, not during
  const evaluatedArg = evaluateExpression({
    expr: argExpr,
    env: callerEnv,
    context: { ...context, expectedType: undefined },
  });

  if (!evaluatedArg.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate argument: ${exprToString(argExpr)}`,
    });
  }

  const env = evaluatedArg.$.env;
  const argValue = evaluatedArg.$.value;
  const argType = evaluatedArg.$.type;

  // Check if the source is a numeric type
  if (
    !isConvertibleNumericType(argType) &&
    !isComptIntType(argType) &&
    !isComptFloatType(argType)
  ) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Cannot convert ${typeToString(argType)} to ${typeToString(targetType)}. Expected a numeric type.`,
    });
  }

  // Case 1: Compile-time value -> any supported type
  const comptValue = extractComptNumericValue(argValue);
  if (comptValue !== undefined && supportsComptValue(targetType)) {
    const resultValue = createComptValueOfType(
      comptValue,
      targetType,
      expr.token
    );
    expr.$ = {
      env,
      type: targetType,
      value: resultValue,
      pathCollection: [],
    };
    return { expr, env };
  }

  // Case 2: Converting TO compt_int or compt_float requires a compile-time value
  if (isComptIntType(targetType) || isComptFloatType(targetType)) {
    if (comptValue === undefined) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Cannot convert runtime value to ${typeToString(targetType)}. Only compile-time values can be converted to ${typeToString(targetType)}.`,
      });
    }
    // Already handled in Case 1
  }

  // Case 3: Runtime conversion - transform to __yo_as(value, TargetType) call
  // For C compatible types or runtime values, we generate __yo_as call
  if (isCCompatibleType(targetType) || !isComptValue(argValue)) {
    // Create __yo_as(value, TargetType) call
    // We need to properly transform the expr
    const yoAsFuncExpr: FuncCallExpr = {
      tag: ExprTag.FuncCall,
      func: {
        tag: ExprTag.Atom,
        token: {
          ...expr.token,
          value: BuiltinFunctions.__yo_as[0]!,
          type: TokenType.Identifier,
        },
        $: undefined,
      },
      // The type expr (expr.func) should already be evaluated or will be treated as type
      args: [evaluatedArg, expr.func],
      token: expr.token,
      $: {
        env,
        type: targetType,
        value: createUnknownValue(targetType),
        pathCollection: evaluatedArg.$.pathCollection,
      },
    };

    // Replace the original expr with the __yo_as call
    replaceExprWithFuncCallExpr(expr, yoAsFuncExpr);

    return { expr, env };
  }

  // Case 4: Compile-time value -> compile-time result (already handled in Case 1)
  // This shouldn't be reached, but just in case
  if (comptValue !== undefined) {
    const resultValue = createComptValueOfType(
      comptValue,
      targetType,
      expr.token
    );
    expr.$ = {
      env,
      type: targetType,
      value: resultValue,
      pathCollection: [],
    };
    return { expr, env };
  }

  throw formatErrorMessage({
    token: expr.token,
    errorMessage: `Unexpected case in numeric type conversion`,
  });
}
