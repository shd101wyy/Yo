import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { FnCallExpr, exprToString } from "../../expr";
import { Token } from "../../token";
import {
  Type,
  TypeTag,
  createBooleanType,
  createCharType,
  createComptFloatType,
  createComptIntType,
  createComptStringType,
  createF32Type,
  createF64Type,
  createI16Type,
  createI32Type,
  createI64Type,
  createI8Type,
  createIntType,
  createIsizeType,
  createLongDoubleType,
  createLongLongType,
  createLongType,
  createShortType,
  createU16Type,
  createU32Type,
  createU64Type,
  createU8Type,
  createUIntType,
  createULongLongType,
  createULongType,
  createUShortType,
  createUsizeType,
  isCCompatibleType,
  isFloatType,
  isIntegerType,
  isTypeHierarchyType,
} from "../../types";
import {
  NumberValue,
  Value,
  createBooleanValue,
  createComptFloatValue,
  createComptIntValue,
  createComptStringValue,
  createNumberValue,
  createUnknownValue,
  isComptFloatValue,
  isComptIntValue,
  isNumberValue,
  isTypeValue,
} from "../../value";
import { ValueTag } from "../../value-tag";
import { getNumericBounds } from "../calls/numeric_type";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

// Helper function to extract numeric value from a Value
function extractNumericValue(value?: Value): number | bigint | null {
  if (
    value &&
    (isComptIntValue(value) || isComptFloatValue(value) || isNumberValue(value))
  ) {
    return value.value;
  }
  return null;
}

// Helper function to create a numeric value of the given type
function createNumericValue(
  value: number | bigint,
  type: Type
): Value | undefined {
  // Handle compt_int and compt_float separately
  if (type.tag === TypeTag.ComptInt) {
    // For compt_int, always convert to BigInt
    const bigValue =
      typeof value === "bigint" ? value : BigInt(Math.floor(value));
    return createComptIntValue(bigValue);
  }
  if (type.tag === TypeTag.ComptFloat) {
    const numValue = typeof value === "bigint" ? Number(value) : value;
    return createComptFloatValue(numValue);
  }

  // C compatible types return unknown value
  if (isCCompatibleType(type)) {
    return createUnknownValue(type);
  }

  // Handle other numeric types
  const tag = getValueTagFromType(type);
  const boundedValue = applyNumericBounds(value, type);
  return createNumberValue(tag as NumberValue["tag"], boundedValue);
}

// Helper function to get ValueTag from Type
function getValueTagFromType(type: Type): ValueTag {
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
    // C compatible types don't have corresponding ValueTags since they're runtime-only
    default:
      throw new Error(`Unsupported numeric type: ${type.tag}`);
  }
}

// Helper function to check for overflow
function checkOverflow(
  value: number | bigint,
  type: Type,
  operation: string,
  lhs: number | bigint,
  rhs: number | bigint,
  token: Token
): void {
  const bounds = getNumericBounds(type);
  if (bounds === undefined) {
    return; // No overflow check for floats
  }

  // Infinity bounds mean unbounded (compt_int)
  if (bounds.min === -Infinity && bounds.max === Infinity) {
    return; // No overflow for unbounded types
  }

  // Helper to compare mixed number/bigint values
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
    const opSymbol =
      operation === "multiply" ? "*" : operation === "add" ? "+" : "-";
    throw formatErrorMessage({
      token,
      errorMessage:
        `Integer overflow in compile-time evaluation\n` +
        `  ${lhs} ${opSymbol} ${rhs} = ${value}\n` +
        `  Result ${value} exceeds ${type.tag} range [${bounds.min}, ${bounds.max}]`,
      kind: "overflow",
    });
  }
}

// Helper function to apply numeric bounds based on type
function applyNumericBounds(
  value: number | bigint,
  type: Type
): number | bigint {
  // Convert to the appropriate type for 64-bit integers
  if (
    type.tag === TypeTag.U64 ||
    type.tag === TypeTag.I64 ||
    type.tag === TypeTag.Usize ||
    type.tag === TypeTag.Isize
  ) {
    const bigValue =
      typeof value === "bigint" ? value : BigInt(Math.floor(value));
    const bounds = getNumericBounds(type)!;
    const min =
      typeof bounds.min === "bigint" ? bounds.min : BigInt(bounds.min);
    const max =
      typeof bounds.max === "bigint" ? bounds.max : BigInt(bounds.max);

    if (bigValue < min) return min;
    if (bigValue > max) return max;
    return bigValue;
  }

  // For smaller integer types, use number
  const numValue = typeof value === "bigint" ? Number(value) : value;

  switch (type.tag) {
    case TypeTag.U8:
      return Math.floor(Math.abs(numValue)) % 256;
    case TypeTag.I8:
      return Math.max(-128, Math.min(127, Math.floor(numValue)));
    case TypeTag.U16:
      return Math.floor(Math.abs(numValue)) % 65536;
    case TypeTag.I16:
      return Math.max(-32768, Math.min(32767, Math.floor(numValue)));
    case TypeTag.U32:
      return Math.floor(Math.abs(numValue)) % 4294967296;
    case TypeTag.I32:
      return Math.max(-2147483648, Math.min(2147483647, Math.floor(numValue)));
    case TypeTag.F32:
    case TypeTag.F64:
      return numValue; // No bounds needed for floats
    default:
      return numValue;
  }
}

// Generic arithmetic operation
function performArithmeticOp(
  lhsValue: Value,
  rhsValue: Value,
  resultType: Type,
  op: (a: number | bigint, b: number | bigint) => number | bigint
): Value {
  const lhs = extractNumericValue(lhsValue);
  const rhs = extractNumericValue(rhsValue);

  if (lhs === null || rhs === null) {
    return createUnknownValue(resultType);
  }

  const result = createNumericValue(op(lhs, rhs), resultType);
  // For C compatible types, createNumericValue returns undefined (runtime-only)
  return result ?? createUnknownValue(resultType);
}

// Generic comparison operation
function performComparisonOp(
  lhsValue: Value,
  rhsValue: Value,
  op: (a: number | bigint, b: number | bigint) => boolean
): Value {
  const lhs = extractNumericValue(lhsValue);
  const rhs = extractNumericValue(rhsValue);

  if (lhs === null || rhs === null) {
    return createUnknownValue(createBooleanType());
  }

  // Handle mixed number/bigint comparisons
  if (typeof lhs === "bigint" || typeof rhs === "bigint") {
    const bigLhs = typeof lhs === "bigint" ? lhs : BigInt(Math.floor(lhs));
    const bigRhs = typeof rhs === "bigint" ? rhs : BigInt(Math.floor(rhs));
    return createBooleanValue(op(bigLhs, bigRhs));
  }

  return createBooleanValue(op(lhs, rhs));
}

// Generic unary operation
function performUnaryOp(
  value: Value,
  resultType: Type,
  op: (a: number | bigint) => number | bigint
): Value {
  const num = extractNumericValue(value);

  if (num === null) {
    return createUnknownValue(resultType);
  }

  const result = createNumericValue(op(num), resultType);
  // For C compatible types, createNumericValue returns undefined (runtime-only)
  return result ?? createUnknownValue(resultType);
}

export function evaluateYoNumericFunctions({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const funcName = expr.func.token.value;

  // Check if this is a numeric function by pattern matching
  const numericFnPattern =
    /^__yo_(u8|i8|u16|i16|u32|i32|u64|i64|usize|isize|f32|f64|compt_int|compt_float|char|short|ushort|int|uint|long|ulong|longlong|ulonglong|longdouble)_(add|sub|mul|div|mod|eq|neq|lt|lte|gt|gte|neg|to_string|as)$/;
  const match = funcName.match(numericFnPattern);

  if (!match) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected numeric function, got: ${funcName}`,
    });
  }

  const [, typeStr, operation] = match;

  // Get the appropriate type
  const getType = (): Type => {
    switch (typeStr) {
      case TypeTag.U8:
        return createU8Type();
      case TypeTag.I8:
        return createI8Type();
      case TypeTag.U16:
        return createU16Type();
      case TypeTag.I16:
        return createI16Type();
      case TypeTag.U32:
        return createU32Type();
      case TypeTag.I32:
        return createI32Type();
      case TypeTag.U64:
        return createU64Type();
      case TypeTag.I64:
        return createI64Type();
      case TypeTag.Usize:
        return createUsizeType();
      case TypeTag.Isize:
        return createIsizeType();
      case TypeTag.F32:
        return createF32Type();
      case TypeTag.F64:
        return createF64Type();
      case TypeTag.Char:
        return createCharType();
      case TypeTag.Short:
        return createShortType();
      case TypeTag.UShort:
        return createUShortType();
      case TypeTag.Int:
        return createIntType();
      case TypeTag.UInt:
        return createUIntType();
      case TypeTag.Long:
        return createLongType();
      case TypeTag.ULong:
        return createULongType();
      case TypeTag.LongLong:
        return createLongLongType();
      case TypeTag.ULongLong:
        return createULongLongType();
      case TypeTag.LongDouble:
        return createLongDoubleType();
      case TypeTag.ComptInt:
        return createComptIntType();
      case TypeTag.ComptFloat:
        return createComptFloatType();
      default:
        throw new Error(`Unknown numeric type: ${typeStr}`);
    }
  };

  const numericType = getType();

  // Handle unary operations
  if (operation === "neg" || operation === "to_string") {
    const arg = evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: { ...context },
    });

    if (!arg.$ || !arg.$.value) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected ${typeStr} type for "${funcName}" argument, got:\n${exprToString(arg)}`,
      });
    }

    env = arg.$.env;
    let value: Value;

    if (operation === "neg") {
      if (isNumberValue(arg.$.value)) {
        value = performUnaryOp(arg.$.value, numericType, (x) => {
          if (typeof x === "bigint") {
            return -x;
          }
          return -x;
        });
      } else {
        value = createUnknownValue(numericType);
      }
    } else if (operation === "to_string") {
      if (isNumberValue(arg.$.value)) {
        const num = extractNumericValue(arg.$.value);
        if (num !== null) {
          value = createComptStringValue(num.toString());
        } else {
          value = createUnknownValue(createComptStringType());
        }
      } else {
        value = createUnknownValue(createComptStringType());
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unexpected unary operation: ${operation}`,
      });
    }

    expr.$ = {
      env,
      type: operation === "to_string" ? createComptStringType() : numericType,
      value: value,
      pathCollection: [],
    };

    return expr;
  }

  // Handle type conversion 'as' operation
  if (operation === "as") {
    const valueArg = evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: { ...context },
    });

    if (!valueArg.$) {
      throw formatErrorMessage({
        token: valueArg.token,
        errorMessage: `Expected numeric value for "${funcName}" first argument, got:\n${exprToString(valueArg)}`,
      });
    }

    env = valueArg.$.env;

    // The second argument should be a type atom (e.g., i32, f64, etc.)
    const targetTypeArg = expr.args[1]!;
    const evaluatedTargetTypeArg = evaluateExpression({
      expr: targetTypeArg,
      env,
      context: { ...context },
    });
    if (!evaluatedTargetTypeArg.$) {
      throw formatErrorMessage({
        token: evaluatedTargetTypeArg.token,
        errorMessage: `Failed to evaluate the argument ${exprToString(evaluatedTargetTypeArg)}`,
      });
    }
    env = evaluatedTargetTypeArg.$.env;

    if (!evaluatedTargetTypeArg.$.value) {
      throw formatErrorMessage({
        token: evaluatedTargetTypeArg.token,
        errorMessage: `Expected type for "${funcName}" second argument, got:\n${exprToString(evaluatedTargetTypeArg)}`,
      });
    }
    if (!isTypeHierarchyType(evaluatedTargetTypeArg.$.type)) {
      throw formatErrorMessage({
        token: evaluatedTargetTypeArg.token,
        errorMessage: `Expected type for "${funcName}" second argument, got:\n${exprToString(evaluatedTargetTypeArg)}`,
      });
    }
    const typeValue = evaluatedTargetTypeArg.$.value;

    if (!isTypeValue(typeValue)) {
      throw formatErrorMessage({
        token: evaluatedTargetTypeArg.token,
        errorMessage: `Expected type value for "${funcName}" second argument, got:\n${exprToString(evaluatedTargetTypeArg)}`,
      });
    }

    const targetType = typeValue.value;
    const sourceValue = extractNumericValue(valueArg.$.value);

    let convertedValue: Value | undefined;
    let resultType: Type;

    /* if (targetType === null) {
      // Unknown target type - return unknown value with the source type
      // This handles generic type parameters like 'Target'
      convertedValue = createUnknownValue(numericType);
      resultType = numericType; // Fallback to source type for unknown target types
    } else */ if (sourceValue !== null) {
      // Perform the conversion with bounds checking
      convertedValue = createNumericValue(sourceValue, targetType);
      resultType = targetType;
    } else {
      // If source value is unknown, result is also unknown
      convertedValue = createUnknownValue(targetType);
      resultType = targetType;
    }

    expr.$ = {
      env,
      type: resultType,
      value: convertedValue,
      pathCollection: [],
    };

    return expr;
  }

  // Handle binary operations
  const lhs = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: { ...context },
  });

  if (!lhs.$ || !lhs.$.value) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Expected ${typeStr} type for "${funcName}" left argument, got:\n${exprToString(lhs)}`,
    });
  }

  env = lhs.$.env;

  const rhs = evaluateExpression({
    expr: expr.args[1]!,
    env,
    context: { ...context },
  });

  if (!rhs.$ || !rhs.$.value) {
    throw formatErrorMessage({
      token: rhs.token,
      errorMessage: `Expected ${typeStr} type for "${funcName}" right argument, got:\n${exprToString(rhs)}`,
    });
  }

  env = rhs.$.env;

  const lhsValue = lhs.$.value;
  const rhsValue = rhs.$.value;

  let value: Value;
  let resultType: Type;

  switch (operation) {
    case "add": {
      const lhs = extractNumericValue(lhsValue);
      const rhs = extractNumericValue(rhsValue);
      if (lhs !== null && rhs !== null) {
        // Handle bigint arithmetic
        const result =
          typeof lhs === "bigint" || typeof rhs === "bigint"
            ? (typeof lhs === "bigint" ? lhs : BigInt(lhs)) +
              (typeof rhs === "bigint" ? rhs : BigInt(rhs))
            : lhs + rhs;
        checkOverflow(result, numericType, "add", lhs, rhs, expr.token);
      }
      value = performArithmeticOp(lhsValue, rhsValue, numericType, (a, b) => {
        if (typeof a === "bigint" || typeof b === "bigint") {
          const bigA = typeof a === "bigint" ? a : BigInt(a);
          const bigB = typeof b === "bigint" ? b : BigInt(b);
          return bigA + bigB;
        }
        return a + b;
      });
      resultType = numericType;
      break;
    }
    case "sub": {
      const lhs = extractNumericValue(lhsValue);
      const rhs = extractNumericValue(rhsValue);
      if (lhs !== null && rhs !== null) {
        const result =
          typeof lhs === "bigint" || typeof rhs === "bigint"
            ? (typeof lhs === "bigint" ? lhs : BigInt(lhs)) -
              (typeof rhs === "bigint" ? rhs : BigInt(rhs))
            : lhs - rhs;
        checkOverflow(result, numericType, "subtract", lhs, rhs, expr.token);
      }
      value = performArithmeticOp(lhsValue, rhsValue, numericType, (a, b) => {
        if (typeof a === "bigint" || typeof b === "bigint") {
          const bigA = typeof a === "bigint" ? a : BigInt(a);
          const bigB = typeof b === "bigint" ? b : BigInt(b);
          return bigA - bigB;
        }
        return a - b;
      });
      resultType = numericType;
      break;
    }
    case "mul": {
      const lhs = extractNumericValue(lhsValue);
      const rhs = extractNumericValue(rhsValue);
      if (lhs !== null && rhs !== null) {
        const result =
          typeof lhs === "bigint" || typeof rhs === "bigint"
            ? (typeof lhs === "bigint" ? lhs : BigInt(lhs)) *
              (typeof rhs === "bigint" ? rhs : BigInt(rhs))
            : lhs * rhs;
        checkOverflow(result, numericType, "multiply", lhs, rhs, expr.token);
      }
      value = performArithmeticOp(lhsValue, rhsValue, numericType, (a, b) => {
        if (typeof a === "bigint" || typeof b === "bigint") {
          const bigA = typeof a === "bigint" ? a : BigInt(a);
          const bigB = typeof b === "bigint" ? b : BigInt(b);
          return bigA * bigB;
        }
        return a * b;
      });
      resultType = numericType;
      break;
    }
    case "div": {
      // Handle division by zero check
      const rhsNum = extractNumericValue(rhsValue);
      if (rhsNum === 0 || rhsNum === 0n) {
        throw formatErrorMessage({
          token: rhs.token,
          errorMessage: `Division by zero in "${funcName}" operation`,
        });
      }
      value = performArithmeticOp(lhsValue, rhsValue, numericType, (a, b) => {
        if (typeof a === "bigint" || typeof b === "bigint") {
          const bigA = typeof a === "bigint" ? a : BigInt(a);
          const bigB = typeof b === "bigint" ? b : BigInt(b);
          return bigA / bigB;
        }
        return isIntegerType(numericType) ||
          numericType.tag === TypeTag.ComptInt
          ? Math.trunc(a / b)
          : a / b;
      });
      resultType = numericType;
      break;
    }
    case "mod": {
      if (isFloatType(numericType)) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Modulo operation not supported for floating point types: ${typeStr}`,
        });
      }
      // Handle modulo by zero check
      const rhsModNum = extractNumericValue(rhsValue);
      if (rhsModNum === 0 || rhsModNum === 0n) {
        throw formatErrorMessage({
          token: rhs.token,
          errorMessage: `Modulo by zero in "${funcName}" operation`,
        });
      }
      value = performArithmeticOp(lhsValue, rhsValue, numericType, (a, b) => {
        if (typeof a === "bigint" || typeof b === "bigint") {
          const bigA = typeof a === "bigint" ? a : BigInt(a);
          const bigB = typeof b === "bigint" ? b : BigInt(b);
          return bigA % bigB;
        }
        return a % b;
      });
      resultType = numericType;
      break;
    }
    case "eq":
      value = performComparisonOp(lhsValue, rhsValue, (a, b) => a === b);
      resultType = createBooleanType();
      break;
    case "neq":
      value = performComparisonOp(lhsValue, rhsValue, (a, b) => a !== b);
      resultType = createBooleanType();
      break;
    case "lt":
      value = performComparisonOp(lhsValue, rhsValue, (a, b) => a < b);
      resultType = createBooleanType();
      break;
    case "lte":
      value = performComparisonOp(lhsValue, rhsValue, (a, b) => a <= b);
      resultType = createBooleanType();
      break;
    case "gt":
      value = performComparisonOp(lhsValue, rhsValue, (a, b) => a > b);
      resultType = createBooleanType();
      break;
    case "gte":
      value = performComparisonOp(lhsValue, rhsValue, (a, b) => a >= b);
      resultType = createBooleanType();
      break;
    default:
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unexpected binary operation: ${operation}`,
      });
  }

  expr.$ = {
    env,
    type: resultType,
    value: value,
    pathCollection: [],
  };

  return expr;
}
