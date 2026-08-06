import { type Environment, getVariablesFromEnv } from "../../env";
import { formatErrorMessage } from "../../error";
import { type AtomExpr } from "../../expr";
import {
  createBooleanType,
  createCharType,
  createComptimeFloatType,
  createComptimeIntType,
  createComptimeStringType,
  createExprType,
  createF32Type,
  createF64Type,
  createI16Type,
  createI32Type,
  createStrType,
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
  createUShortType,
  createUsizeType,
  createVoidType,
} from "../../types/creators";
import {
  isFunctionType,
  isSomeType,
  isTypeHierarchyType,
} from "../../types/guards";
import { getValueOfSomeTypeFromEnv } from "../../types/env-lookup";
import { TypeTag } from "../../types/tags";
import { createTypeValue, isTypeValue, isUnknownValue } from "../../value";
import { type EvaluatorContext, trackVariableUsage } from "../context";

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
  const identifier = expr.token.value;

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
  // Trait
  else if (identifier === "Trait") {
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
  // comptime_int
  else if (identifier === TypeTag.ComptimeInt) {
    const value = createTypeValue(createComptimeIntType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  // comptime_float
  else if (identifier === TypeTag.ComptimeFloat) {
    const value = createTypeValue(createComptimeFloatType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  // comptime_str
  else if (identifier === TypeTag.ComptimeString) {
    const value = createTypeValue(createComptimeStringType());
    expr.$ = {
      env,
      type: value.type,
      value: value,

      pathCollection: [],
    };
    return expr;
  }
  // boolean
  else if (identifier === TypeTag.Bool) {
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
  // str — builtin static string view (plans/archive/SLICE_REWORK.md)
  else if (identifier === TypeTag.Str) {
    const value = createTypeValue(createStrType());
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
    const value = createTypeValue(createUShortType());
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
  // Self - check context.SelfType BEFORE looking up variables
  // This ensures that Self from the type context takes precedence over
  // any variable named "Self" in the environment.
  // EXCEPTION: If context.SelfType is a SomeType that has been bound in the env
  // (e.g. via type synthesis during a method dispatch like
  // `*(Self)` matched against `*(TreeNode)`), use the bound concrete type.
  // This is essential for evaluateFunctionParameterTypeAgain to resolve `Self`
  // to the synthesized argument type instead of the abstract trait Self placeholder.
  else if (identifier === "Self" && context.SelfType) {
    let resolvedSelfType = context.SelfType;
    if (isSomeType(resolvedSelfType)) {
      const bound = getValueOfSomeTypeFromEnv(env, resolvedSelfType);
      if (!isSomeType(bound)) {
        resolvedSelfType = bound;
      }
    }
    const typeValue = createTypeValue(resolvedSelfType);

    expr.$ = {
      env,
      type: typeValue.type,
      value: typeValue,

      pathCollection: [],
    };
    return expr;
  }
  // SelfTrait - refers to the trait type currently being defined
  // Only available inside trait(...) definitions
  else if (identifier === "SelfTrait" && context.SelfTraitType) {
    const typeValue = createTypeValue(context.SelfTraitType);

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
        if (
          !isFunctionType(variable.type) &&
          !isTypeValue(variable.value?.[0])
        ) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `Variable "${identifier}" is not initialized`,
          });
        }
        // We support FunctionType and TypeValue for mutual recursion
      }

      // c_include constants (e.g., O_RDONLY : i32 from <fcntl.h>) have UnknownValue
      // because their actual values are only known to the C compiler.
      // Treat them as runtime values so operators like | use runtime BitOr
      // instead of ComptimeBitOr which can't fold the unknown values.
      const resolvedValue =
        variable.type.isExtern === "c" &&
        isUnknownValue(variable.value?.[0]) &&
        /**
         * Skip the case like:
         *    SomeType : Type,
         *    some_func : (fn() -> unit),
         */
        !(isFunctionType(variable.type) || isTypeHierarchyType(variable.type))
          ? undefined
          : variable.value?.[0];

      expr.$ = {
        env,
        type: variable.type,
        value: resolvedValue,
        originType: variable.type, // Set origin type for direct variable access
        variableName: variable.name,
        pathCollection: [[variable.name]],
        sourceVariable: variable,
      };

      // Check if the variable has been consumed (for linear types including closures)
      /// console.log(`=== Checking variable ${variable.name} ===`);
      /// console.log("Variable type:", typeToString(variable.type));
      /// console.log("Type hierarchy:", typeToString(typeOfType(variable.type)));

      // For closures, track variables captured from outer scopes
      if (
        context.isEvaluatingFunctionBodyOrAsyncBlock &&
        context.isEvaluatingFunctionBodyOrAsyncBlock.kind === "function-body" &&
        context.capturedVariables &&
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
