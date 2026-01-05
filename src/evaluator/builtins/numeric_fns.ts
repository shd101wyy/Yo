import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { FuncCallExpr, exprToString } from "../../expr";
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
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

// Helper function to extract numeric value from a Value
function extractNumericValue(value?: Value): number | null {
  if (
    value &&
    (isComptIntValue(value) || isComptFloatValue(value) || isNumberValue(value))
  ) {
    return value.value;
  }
  return null;
}

// Helper function to create a numeric value of the given type
function createNumericValue(value: number, type: Type): Value | undefined {
  // Handle compt_int and compt_float separately
  if (type.tag === TypeTag.ComptInt) {
    return createComptIntValue(value);
  }
  if (type.tag === TypeTag.ComptFloat) {
    return createComptFloatValue(value);
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

// Helper function to get min and max values for integer types
function getIntegerBounds(type: Type): { min: number; max: number } | null {
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
      return { min: 0, max: Number.MAX_SAFE_INTEGER };
    case TypeTag.I64:
      return { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };
    case TypeTag.Usize:
      return { min: 0, max: Number.MAX_SAFE_INTEGER };
    case TypeTag.Isize:
      return { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };
    case TypeTag.ComptInt:
      return { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };
    default:
      return null; // Not an integer type or float type
  }
}

// Helper function to check for overflow
function checkOverflow(
  value: number,
  type: Type,
  operation: string,
  lhs: number,
  rhs: number,
  token: Token
): void {
  const bounds = getIntegerBounds(type);
  if (bounds === null) {
    return; // No overflow check for floats
  }

  if (value < bounds.min || value > bounds.max) {
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
function applyNumericBounds(value: number, type: Type): number {
  switch (type.tag) {
    case TypeTag.U8:
      return Math.floor(Math.abs(value)) % 256;
    case TypeTag.I8:
      return Math.max(-128, Math.min(127, Math.floor(value)));
    case TypeTag.U16:
      return Math.floor(Math.abs(value)) % 65536;
    case TypeTag.I16:
      return Math.max(-32768, Math.min(32767, Math.floor(value)));
    case TypeTag.U32:
      return Math.floor(Math.abs(value)) % 4294967296;
    case TypeTag.I32:
      return Math.max(-2147483648, Math.min(2147483647, Math.floor(value)));
    case TypeTag.U64:
      return Math.max(0, Math.floor(value));
    case TypeTag.I64:
      return Math.floor(value);
    case TypeTag.Usize:
      return Math.max(0, Math.floor(value));
    case TypeTag.Isize:
      return Math.floor(value);
    case TypeTag.F32:
    case TypeTag.F64:
      return value; // No bounds needed for floats
    default:
      return value;
  }
}

// Generic arithmetic operation
function performArithmeticOp(
  lhsValue: Value,
  rhsValue: Value,
  resultType: Type,
  op: (a: number, b: number) => number
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
  op: (a: number, b: number) => boolean
): Value {
  const lhs = extractNumericValue(lhsValue);
  const rhs = extractNumericValue(rhsValue);

  if (lhs === null || rhs === null) {
    return createUnknownValue(createBooleanType());
  }

  return createBooleanValue(op(lhs, rhs));
}

// Generic unary operation
function performUnaryOp(
  value: Value,
  resultType: Type,
  op: (a: number) => number
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
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
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
        value = performUnaryOp(arg.$.value, numericType, (x) => -x);
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
        const result = lhs + rhs;
        checkOverflow(result, numericType, "add", lhs, rhs, expr.token);
      }
      value = performArithmeticOp(
        lhsValue,
        rhsValue,
        numericType,
        (a, b) => a + b
      );
      resultType = numericType;
      break;
    }
    case "sub": {
      const lhs = extractNumericValue(lhsValue);
      const rhs = extractNumericValue(rhsValue);
      if (lhs !== null && rhs !== null) {
        const result = lhs - rhs;
        checkOverflow(result, numericType, "subtract", lhs, rhs, expr.token);
      }
      value = performArithmeticOp(
        lhsValue,
        rhsValue,
        numericType,
        (a, b) => a - b
      );
      resultType = numericType;
      break;
    }
    case "mul": {
      const lhs = extractNumericValue(lhsValue);
      const rhs = extractNumericValue(rhsValue);
      if (lhs !== null && rhs !== null) {
        const result = lhs * rhs;
        checkOverflow(result, numericType, "multiply", lhs, rhs, expr.token);
      }
      value = performArithmeticOp(
        lhsValue,
        rhsValue,
        numericType,
        (a, b) => a * b
      );
      resultType = numericType;
      break;
    }
    case "div": {
      // Handle division by zero check
      const rhsNum = extractNumericValue(rhsValue);
      if (rhsNum === 0) {
        throw formatErrorMessage({
          token: rhs.token,
          errorMessage: `Division by zero in "${funcName}" operation`,
        });
      }
      value = performArithmeticOp(lhsValue, rhsValue, numericType, (a, b) => {
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
      if (rhsModNum === 0) {
        throw formatErrorMessage({
          token: rhs.token,
          errorMessage: `Modulo by zero in "${funcName}" operation`,
        });
      }
      value = performArithmeticOp(
        lhsValue,
        rhsValue,
        numericType,
        (a, b) => a % b
      );
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
