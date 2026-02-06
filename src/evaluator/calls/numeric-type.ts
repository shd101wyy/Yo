import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  type Expr,
  ExprTag,
  exprToString,
  type FnCallExpr,
  replaceExprWithFuncCallExpr,
} from "../../expr";
import { TokenType } from "../../token";
import type { Type } from "../../types/definitions";
import {
  isCCompatibleType,
  isComptimeFloatType,
  isComptimeIntType,
  isEnumType,
  isFloatType,
  isIntegerType,
} from "../../types/guards";
import { TypeTag } from "../../types/tags";
import { typeToString } from "../../types/utils";
import {
  createComptimeFloatValue,
  createComptimeIntValue,
  createNumberValue,
  createUnknownValue,
  type EnumValue,
  isComptimeFloatValue,
  isComptimeIntValue,
  isEnumValue,
  isNumberValue,
  type NumberValue,
  type Value,
} from "../../value";
import { ValueTag } from "../../value-tag";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { typeImplementsComptime } from "../trait-checking";

/**
 * Get the numeric bounds for a type.
 * Returns [min, max] for the type, or undefined if the type has no fixed bounds.
 */
export function getNumericBounds(
  type: Type
): { min: number | bigint; max: number | bigint } | undefined {
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
      return { min: 0n, max: 18446744073709551615n };
    case TypeTag.I64:
      return { min: -9223372036854775808n, max: 9223372036854775807n };
    case TypeTag.Usize:
      return { min: 0n, max: 18446744073709551615n };
    case TypeTag.Isize:
      return { min: -9223372036854775808n, max: 9223372036854775807n };
    case TypeTag.ComptimeInt:
      return { min: -Infinity, max: Infinity }; // Unbounded
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
 * Check if a type is a convertible numeric type.
 * This includes all numeric types that can be used with type(value) syntax.
 */
export function isConvertibleNumericType(type: Type): boolean {
  return (
    isIntegerType(type) ||
    isFloatType(type) ||
    isComptimeIntType(type) ||
    isComptimeFloatType(type) ||
    isCCompatibleType(type)
  );
}

/**
 * Get the discriminant value for an enum value.
 * Returns the discriminant if the variant is found, undefined otherwise.
 */
function getEnumDiscriminant(enumValue: EnumValue): bigint | undefined {
  const enumType = enumValue.type;
  const variant = enumType.variants.find(
    (v) => v.name === enumValue.variantName
  );
  return variant?.discriminant;
}

/**
 * Extract numeric value from a Value if it's compile-time known.
 */
function extractComptimeNumericValue(
  value?: Value
): number | bigint | undefined {
  if (!value) return undefined;
  // isNumberValue includes ComptimeInt, ComptimeFloat, and all concrete numeric types
  if (isNumberValue(value)) {
    return value.value;
  }
  return undefined;
}

/**
 * Check if a number value is compile-time known.
 */
function isComptimeNumberValue(value?: Value): boolean {
  return (
    isComptimeIntValue(value) ||
    isComptimeFloatValue(value) ||
    isNumberValue(value)
  );
}

/**
 * Create a compile-time value of the target type.
 */
function createComptimeValueOfType(
  numericValue: number | bigint,
  targetType: Type,
  errorToken: Expr["token"]
): Value {
  // Check bounds for integer types at compile time
  const bounds = getNumericBounds(targetType);
  if (bounds) {
    // Handle mixed number/bigint comparisons
    const value = numericValue;
    const lessThan = (a: number | bigint, b: number | bigint): boolean => {
      if (typeof a === "bigint" || typeof b === "bigint") {
        const bigA = typeof a === "bigint" ? a : BigInt(Math.floor(a));
        const bigB = typeof b === "bigint" ? b : BigInt(Math.floor(b));
        return bigA < bigB;
      }
      return a < b;
    };
    const greaterThan = (a: number | bigint, b: number | bigint): boolean => {
      if (typeof a === "bigint" || typeof b === "bigint") {
        const bigA = typeof a === "bigint" ? a : BigInt(Math.floor(a));
        const bigB = typeof b === "bigint" ? b : BigInt(Math.floor(b));
        return bigA > bigB;
      }
      return a > b;
    };

    if (lessThan(value, bounds.min) || greaterThan(value, bounds.max)) {
      throw formatErrorMessage({
        token: errorToken,
        errorMessage: `Value ${numericValue} is out of range for type ${typeToString(targetType)} (${bounds.min} to ${bounds.max})`,
      });
    }
  }

  // Create the appropriate value type
  if (isComptimeIntType(targetType)) {
    const bigValue =
      typeof numericValue === "bigint"
        ? numericValue
        : BigInt(Math.floor(numericValue));
    return createComptimeIntValue(bigValue);
  }
  if (isComptimeFloatType(targetType)) {
    const numValue =
      typeof numericValue === "bigint" ? Number(numericValue) : numericValue;
    return createComptimeFloatValue(numValue);
  }
  if (isFloatType(targetType)) {
    const tag = getValueTagFromType(targetType);
    if (tag) {
      const numValue =
        typeof numericValue === "bigint" ? Number(numericValue) : numericValue;
      return createNumberValue(tag as NumberValue["tag"], numValue);
    }
  }
  if (isIntegerType(targetType)) {
    const tag = getValueTagFromType(targetType);
    if (tag) {
      // For 64-bit types, keep as BigInt
      const is64Bit =
        tag === ValueTag.U64 ||
        tag === ValueTag.I64 ||
        tag === ValueTag.Usize ||
        tag === ValueTag.Isize;

      if (is64Bit) {
        const bigValue =
          typeof numericValue === "bigint"
            ? numericValue
            : BigInt(Math.floor(numericValue));
        return createNumberValue(tag as NumberValue["tag"], bigValue);
      } else {
        const numValue =
          typeof numericValue === "bigint"
            ? Number(numericValue)
            : Math.floor(numericValue);
        return createNumberValue(tag as NumberValue["tag"], numValue);
      }
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
  expr: FnCallExpr;
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

  // Handle enum value to numeric conversion
  if (isEnumType(argType) && isEnumValue(argValue)) {
    const discriminant = getEnumDiscriminant(argValue);
    if (discriminant === undefined) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to get discriminant for enum variant "${argValue.variantName}"`,
      });
    }

    if (typeImplementsComptime(targetType, env)) {
      const resultValue = createComptimeValueOfType(
        discriminant,
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
  }

  // Check if the source is a numeric type
  if (
    !isConvertibleNumericType(argType) &&
    !isComptimeIntType(argType) &&
    !isComptimeFloatType(argType) &&
    !isEnumType(argType)
  ) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Cannot convert ${typeToString(argType)} to ${typeToString(targetType)}. Expected a numeric type.`,
    });
  }

  // Case 1: Compile-time value -> any supported type
  const comptimeValue = extractComptimeNumericValue(argValue);
  if (comptimeValue !== undefined && typeImplementsComptime(targetType, env)) {
    const resultValue = createComptimeValueOfType(
      comptimeValue,
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

  // Case 2: Converting TO comptime_int or comptime_float requires a compile-time value
  if (isComptimeIntType(targetType) || isComptimeFloatType(targetType)) {
    if (comptimeValue === undefined) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Cannot convert runtime value to ${typeToString(targetType)}. Only compile-time values can be converted to ${typeToString(targetType)}.`,
      });
    }
    // Already handled in Case 1
  }

  // Case 2.5: If the arg type is a compile-time type (comptime_int or comptime_float)
  // and the target type supports compile-time values, we can handle it at compile-time.
  // This is important for the checking phase where we don't have the actual value yet,
  // but we know from the type that it will be a compile-time value.
  // We create an UnknownValue with the target type to indicate that this will be
  // a compile-time value once the actual value is known.
  if (
    (isComptimeIntType(argType) || isComptimeFloatType(argType)) &&
    typeImplementsComptime(targetType, env)
  ) {
    // During checking phase, we may have a placeholder value but the type tells us
    // this will be a compile-time conversion. Create an appropriate value.
    if (comptimeValue !== undefined) {
      // We have the actual value, create the result
      const resultValue = createComptimeValueOfType(
        comptimeValue,
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
    } else {
      // We don't have the value yet (checking phase), but we know from the type
      // that this will be a compile-time value. Create an UnknownValue with the
      // target type to indicate that the conversion is valid.
      expr.$ = {
        env,
        type: targetType,
        value: createUnknownValue(targetType, {
          variableName: "comptime_conversion_placeholder",
          env,
          context,
        }),
        pathCollection: [],
      };
      return { expr, env };
    }
  }

  // Case 3: Runtime conversion - transform to __yo_as(value, TargetType) call
  // For C compatible types or runtime values, we generate __yo_as call
  if (isCCompatibleType(targetType) || !isComptimeNumberValue(argValue)) {
    // Create __yo_as(value, TargetType) call
    // We need to properly transform the expr
    const yoAsFuncExpr: FnCallExpr = {
      tag: ExprTag.FnCall,
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
        value: undefined, // createUnknownValue(targetType),
        pathCollection: evaluatedArg.$.pathCollection,
      },
    };

    // Replace the original expr with the __yo_as call
    replaceExprWithFuncCallExpr(expr, yoAsFuncExpr);

    return { expr, env };
  }

  // Case 4: Compile-time value -> compile-time result (already handled in Case 1)
  // This shouldn't be reached, but just in case
  if (comptimeValue !== undefined) {
    const resultValue = createComptimeValueOfType(
      comptimeValue,
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
