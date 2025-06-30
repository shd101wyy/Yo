import { Environment, getVariablesFromEnv } from "../../env";
import { formatErrorMessage } from "../../error";
import { AtomExpr } from "../../expr";
import { TokenType } from "../../token";
import {
  createBooleanType,
  createCCharType,
  createCIntType,
  createCLongDoubleType,
  createCLongLongType,
  createCLongType,
  createComptFloatType,
  createComptIntType,
  createComptStringType,
  createCShortType,
  createCUIntType,
  createCULongLongType,
  createCULongType,
  createExprListType,
  createExprType,
  createF32Type,
  createF64Type,
  createFreeType,
  createI16Type,
  createI32Type,
  createI64Type,
  createI8Type,
  createIsizeType,
  createLinearType,
  createTypeHierarchy,
  createTypeType,
  createU16Type,
  createU32Type,
  createU64Type,
  createU8Type,
  createUnitType,
  createUsizeType,
  isEnumType,
  isStructType,
  isUnionType,
  TypeTag,
} from "../../types";
import { createTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateIdentifierAndOperator({
  expr,
  env,
  context,
  throwErrorOnUndefined,
}: {
  expr: AtomExpr;
  env: Environment;
  context: EvaluatorContext;
  throwErrorOnUndefined: boolean;
}): AtomExpr {
  const identifier =
    expr.token.type === TokenType.BacktickIdentifier
      ? expr.token.value.slice(1, -1) // Remove backticks
      : expr.token.value;

  // Free
  if (identifier === TypeTag.Free) {
    const value = createTypeValue(createFreeType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // Linear
  else if (identifier === TypeTag.Linear) {
    const value = createTypeValue(createLinearType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // Type
  else if (identifier === TypeTag.Type) {
    const value = createTypeValue(createTypeType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // Module
  else if (identifier === "Module") {
    const value = createTypeValue(createTypeHierarchy(1));
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // unit
  else if (identifier === TypeTag.Unit) {
    const value = createTypeValue(createUnitType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // compt_int
  else if (identifier === TypeTag.ComptInt) {
    const value = createTypeValue(createComptIntType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // compt_float
  else if (identifier === TypeTag.ComptFloat) {
    const value = createTypeValue(createComptFloatType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // compt_string
  else if (identifier === TypeTag.ComptString) {
    const value = createTypeValue(createComptStringType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // boolean
  else if (identifier === TypeTag.Boolean) {
    const value = createTypeValue(createBooleanType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // usize
  else if (identifier === TypeTag.Usize) {
    const value = createTypeValue(createUsizeType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // isize
  else if (identifier === TypeTag.Isize) {
    const value = createTypeValue(createIsizeType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // u8
  else if (identifier === TypeTag.U8) {
    const value = createTypeValue(createU8Type());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // i8
  else if (identifier === TypeTag.I8) {
    const value = createTypeValue(createI8Type());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // u16
  else if (identifier === TypeTag.U16) {
    const value = createTypeValue(createU16Type());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // i16
  else if (identifier === TypeTag.I16) {
    const value = createTypeValue(createI16Type());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // u32
  else if (identifier === TypeTag.U32) {
    const value = createTypeValue(createU32Type());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // i32
  else if (identifier === TypeTag.I32) {
    const value = createTypeValue(createI32Type());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // u64
  else if (identifier === TypeTag.U64) {
    const value = createTypeValue(createU64Type());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // i64
  else if (identifier === TypeTag.I64) {
    const value = createTypeValue(createI64Type());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // f32
  else if (identifier === TypeTag.F32) {
    const value = createTypeValue(createF32Type());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // f64
  else if (identifier === TypeTag.F64) {
    const value = createTypeValue(createF64Type());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // c_char
  else if (identifier === "c_char") {
    const value = createTypeValue(createCCharType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // c_short
  else if (identifier === "c_short") {
    const value = createTypeValue(createCShortType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  //  c_ushort
  else if (identifier === "c_ushort") {
    const value = createTypeValue(createCShortType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // c_int
  else if (identifier === "c_int") {
    const value = createTypeValue(createCIntType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // c_uint
  else if (identifier === "c_uint") {
    const value = createTypeValue(createCUIntType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // c_long
  else if (identifier === "c_long") {
    const value = createTypeValue(createCLongType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // c_ulong
  else if (identifier === "c_ulong") {
    const value = createTypeValue(createCULongType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // c_longlong
  else if (identifier === "c_longlong") {
    const value = createTypeValue(createCLongLongType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // c_ulonglong
  else if (identifier === "c_ulonglong") {
    const value = createTypeValue(createCULongLongType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // c_longdouble
  else if (identifier === "c_longdouble") {
    const value = createTypeValue(createCLongDoubleType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // Expr
  else if (identifier === TypeTag.Expr) {
    const value = createTypeValue(createExprType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // ExprList
  else if (identifier === TypeTag.ExprList) {
    const value = createTypeValue(createExprListType());
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // Self
  else if (
    identifier === "Self" &&
    context.SelfType &&
    (isStructType(context.SelfType) ||
      isEnumType(context.SelfType) ||
      isUnionType(context.SelfType))
  ) {
    const typeValue = createTypeValue(context.SelfType);

    expr.$ = {
      env,
      type: typeValue.type,
      value: typeValue,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
  // variable
  else {
    const variables = getVariablesFromEnv(env, identifier);
    if (!variables.length) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Variable "${identifier}" not found`,
      });
    } else {
      const variable = variables[variables.length - 1]!;
      if (!variable.initializedAtToken && throwErrorOnUndefined) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Variable "${identifier}" is not initialized`,
        });
      }

      expr.$ = {
        env,
        type: variable.type,
        value: variable.value,
        isMutable: variable.isMutable,
        variableName: variable.name, // NOTE: The tempVariableName here is the variable name itself.
        pathCollection: [[variable.name]],
      };
      return expr;
    }
  }
}
