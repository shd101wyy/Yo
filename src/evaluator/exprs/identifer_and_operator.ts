import { Environment, getVariablesFromEnv } from "../../env";
import { formatErrorMessage } from "../../error";
import { AtomExpr } from "../../expr";
import { TokenType } from "../../token";
import {
  createType0,
  createTypeHierarchy,
  createVoidType,
  isFunctionType,
  PrimitiveTypes,
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
    const value = createTypeValue(PrimitiveTypes.unit);
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
    const value = createTypeValue(PrimitiveTypes.compt_int);
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
    const value = createTypeValue(PrimitiveTypes.compt_float);
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
    const value = createTypeValue(PrimitiveTypes.compt_string);
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
    const value = createTypeValue(PrimitiveTypes.boolean);
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
    const value = createTypeValue(PrimitiveTypes.usize);
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
    const value = createTypeValue(PrimitiveTypes.isize);
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
    const value = createTypeValue(PrimitiveTypes.u8);
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
    const value = createTypeValue(PrimitiveTypes.i8);
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
    const value = createTypeValue(PrimitiveTypes.u16);
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
    const value = createTypeValue(PrimitiveTypes.i16);
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
    const value = createTypeValue(PrimitiveTypes.u32);
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
    const value = createTypeValue(PrimitiveTypes.i32);
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
    const value = createTypeValue(PrimitiveTypes.u64);
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
    const value = createTypeValue(PrimitiveTypes.i64);
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
    const value = createTypeValue(PrimitiveTypes.f32);
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
    const value = createTypeValue(PrimitiveTypes.f64);
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
    const value = createTypeValue(PrimitiveTypes.char);
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
    const value = createTypeValue(PrimitiveTypes.short);
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
    const value = createTypeValue(PrimitiveTypes.short);
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
    const value = createTypeValue(PrimitiveTypes.int);
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
    const value = createTypeValue(PrimitiveTypes.uint);
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
    const value = createTypeValue(PrimitiveTypes.long);
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
    const value = createTypeValue(PrimitiveTypes.ulong);
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
    const value = createTypeValue(PrimitiveTypes.longlong);
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
    const value = createTypeValue(PrimitiveTypes.ulonglong);
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
    const value = createTypeValue(PrimitiveTypes.longdouble);
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
    const value = createTypeValue(PrimitiveTypes.Expr);
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
    const value = createTypeValue(PrimitiveTypes.ExprList);
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  // Self - check context.SelfType BEFORE looking up variables
  // This ensures that Self from the type context takes precedence over
  // any variable named "Self" in the environment
  else if (identifier === "Self" && context.SelfType) {
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
        context.isEvaluatingFunctionBodyOrAsyncBlock &&
        context.isEvaluatingFunctionBodyOrAsyncBlock.kind === "function-body" &&
        context.isEvaluatingFunctionBodyOrAsyncBlock.type.isClosure &&
        context.isEvaluatingFunctionBodyOrAsyncBlock.evaluationEnv
      ) {
        const closureEvaluationFrameLevel =
          context.isEvaluatingFunctionBodyOrAsyncBlock.evaluationEnv.frames
            .length;

        // If variable is from an outer scope (lower frame level than closure evaluation), it's captured
        if (variable.frameLevel < closureEvaluationFrameLevel) {
          // Determine usage type based on closure kind
          const usageType = "own";
          /*
            context.isEvaluatingFunctionBodyOrAsyncBlock.type.closureKind === "FnMove"
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

      // For async blocks, track variables captured from outer scopes
      if (
        context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "async-block"
      ) {
        const asyncBlockEvaluationFrameLevel =
          context.isEvaluatingFunctionBodyOrAsyncBlock.evaluationEnv.frames
            .length;

        // If variable is from an outer scope (lower frame level than async block evaluation), it's captured
        if (variable.frameLevel < asyncBlockEvaluationFrameLevel) {
          // Async blocks always own the captured variables (move semantics)
          const usageType = "own";
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
