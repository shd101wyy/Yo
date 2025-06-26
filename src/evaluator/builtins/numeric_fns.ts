import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { FuncCallExpr, exprToString } from "../../expr";
import {
  Type,
  TypeTag,
  createBooleanType,
  createCCharType,
  createCIntType,
  createCLongDoubleType,
  createCLongLongType,
  createCLongType,
  createCShortType,
  createCUIntType,
  createCULongLongType,
  createCULongType,
  createCUShortType,
  createComptFloatType,
  createComptIntType,
  createComptStringType,
  createF32Type,
  createF64Type,
  createI16Type,
  createI32Type,
  createI64Type,
  createI8Type,
  createIsizeType,
  createU16Type,
  createU32Type,
  createU64Type,
  createU8Type,
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
    /^__yo_(u8|i8|u16|i16|u32|i32|u64|i64|usize|isize|f32|f64|compt_int|compt_float|c_(?:char|short|ushort|int|uint|long|ulong|longlong|ulonglong|longdouble))_(add|sub|mul|div|mod|eq|neq|lt|lte|gt|gte|neg|to_string|as)$/;
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
      case "u8":
        return createU8Type();
      case "i8":
        return createI8Type();
      case "u16":
        return createU16Type();
      case "i16":
        return createI16Type();
      case "u32":
        return createU32Type();
      case "i32":
        return createI32Type();
      case "u64":
        return createU64Type();
      case "i64":
        return createI64Type();
      case "usize":
        return createUsizeType();
      case "isize":
        return createIsizeType();
      case "f32":
        return createF32Type();
      case "f64":
        return createF64Type();
      case "c_char":
        return createCCharType();
      case "c_short":
        return createCShortType();
      case "c_ushort":
        return createCUShortType();
      case "c_int":
        return createCIntType();
      case "c_uint":
        return createCUIntType();
      case "c_long":
        return createCLongType();
      case "c_ulong":
        return createCULongType();
      case "c_longlong":
        return createCLongLongType();
      case "c_ulonglong":
        return createCULongLongType();
      case "c_longdouble":
        return createCLongDoubleType();
      case "compt_int":
        return createComptIntType();
      case "compt_float":
        return createComptFloatType();
      default:
        throw new Error(`Unknown numeric type: ${typeStr}`);
    }
  };

  const numericType = getType();

  // Handle unary operations
  if (operation === "neg" || operation === "to_string") {
    const arg = context.evaluateExpression({
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
      isMutable: false,
      pathCollection: [],
    };

    return expr;
  }

  // Handle type conversion 'as' operation
  if (operation === "as") {
    const valueArg = context.evaluateExpression({
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
    const evaluatedTargetTypeArg = context.evaluateExpression({
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
      isMutable: false,
      pathCollection: [],
    };

    return expr;
  }

  // Handle binary operations
  const lhs = context.evaluateExpression({
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

  const rhs = context.evaluateExpression({
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
    case "add":
      value = performArithmeticOp(
        lhsValue,
        rhsValue,
        numericType,
        (a, b) => a + b
      );
      resultType = numericType;
      break;
    case "sub":
      value = performArithmeticOp(
        lhsValue,
        rhsValue,
        numericType,
        (a, b) => a - b
      );
      resultType = numericType;
      break;
    case "mul":
      value = performArithmeticOp(
        lhsValue,
        rhsValue,
        numericType,
        (a, b) => a * b
      );
      resultType = numericType;
      break;
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
    isMutable: false,
    pathCollection: [],
  };

  return expr;
}
