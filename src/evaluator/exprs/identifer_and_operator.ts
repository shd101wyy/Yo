import { Environment, getVariablesFromEnv } from "../../env";
import { formatErrorMessage } from "../../error";
import { AtomExpr } from "../../expr";
import { TokenType } from "../../token";
import {
  createBooleanType,
  createCharType,
  createComptFloatType,
  createComptIntType,
  createComptStringType,
  createExprListType,
  createExprType,
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
  createType0,
  createTypeHierarchy,
  createU16Type,
  createU32Type,
  createU64Type,
  createU8Type,
  createUIntType,
  createULongLongType,
  createULongType,
  createUnitType,
  createUsizeType,
  createVoidType,
  isChanType,
  isClosureType,
  isDynType,
  isEnumType,
  isFunctionType,
  isStructType,
  isUnionType,
  TypeTag,
} from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext, trackVariableUsage } from "../context";

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

  // Type
  if (identifier === TypeTag.Type) {
    const value = createTypeValue(createType0());
    expr.$ = {
      env,
      type: value.type,
      value: value,

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

      pathCollection: [],
    };
    return expr;
  }
  // char
  else if (identifier === TypeTag.Char) {
    const value = createTypeValue(createCharType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  // short
  else if (identifier === TypeTag.Short) {
    const value = createTypeValue(createShortType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  //  ushort
  else if (identifier === TypeTag.UShort) {
    const value = createTypeValue(createShortType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  // int
  else if (identifier === TypeTag.Int) {
    const value = createTypeValue(createIntType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  // uint
  else if (identifier === TypeTag.UInt) {
    const value = createTypeValue(createUIntType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  // long
  else if (identifier === TypeTag.Long) {
    const value = createTypeValue(createLongType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  // ulong
  else if (identifier === TypeTag.ULong) {
    const value = createTypeValue(createULongType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  // longlong
  else if (identifier === TypeTag.LongLong) {
    const value = createTypeValue(createLongLongType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  // ulonglong
  else if (identifier === TypeTag.ULongLong) {
    const value = createTypeValue(createULongLongType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  // longdouble
  else if (identifier === TypeTag.LongDouble) {
    const value = createTypeValue(createLongDoubleType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  // void
  else if (identifier === TypeTag.Void) {
    const value = createTypeValue(createVoidType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

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
      isUnionType(context.SelfType) ||
      isDynType(context.SelfType) ||
      isClosureType(context.SelfType) ||
      isChanType(context.SelfType))
  ) {
    const typeValue = createTypeValue(context.SelfType);

    expr.$ = {
      env,
      type: typeValue.type,
      value: typeValue,

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
        errorMessage: `Variable "${identifier}" not found.`,
      });
    } else {
      const variable = variables[variables.length - 1]!;
      if (!variable.initializedAtToken && throwErrorOnUndefined) {
        // Allow forward references for function types to support mutual recursion
        if (!isFunctionType(variable.type) && !isTypeValue(variable.value)) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `Variable "${identifier}" is not initialized`,
          });
        }
        // We support FunctionType and TypeValue for mutual recursion
      }

      expr.$ = {
        env,
        type: variable.type,
        value: variable.value,
        originType: variable.type, // Set origin type for direct variable access
        variableName: variable.isBorrowingTheARCValueOfVariable
          ? variable.isBorrowingTheARCValueOfVariable.name
          : variable.name, // NOTE: The tempVariableName here is the variable name itself.
        pathCollection: [[variable.name]],
      };

      // Check if the variable has been consumed (for linear types including closures)
      /// console.log(`=== Checking variable ${variable.name} ===`);
      /// console.log("Variable type:", typeToString(variable.type));
      /// console.log("Type hierarchy:", typeToString(typeOfType(variable.type)));

      // For closures, track variables captured from outer scopes
      if (
        context.isEvaluatingFunctionBody &&
        context.isEvaluatingFunctionBody.type.isClosure &&
        context.isEvaluatingFunctionBody.evaluationEnv
      ) {
        const closureEvaluationFrameLevel =
          context.isEvaluatingFunctionBody.evaluationEnv.frames.length;

        // If variable is from an outer scope (lower frame level than closure evaluation), it's captured
        if (variable.frameLevel < closureEvaluationFrameLevel) {
          // Determine usage type based on closure kind
          const usageType = "own";
          /*
            context.isEvaluatingFunctionBody.type.closureKind === "FnMove"
              ? "own"
              : "read";
          */
          trackVariableUsage(
            variable.name,
            variable.frameLevel,
            usageType,
            expr.token,
            context
          );
        }
      }

      return expr;
    }
  }
}
