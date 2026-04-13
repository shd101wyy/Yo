import { addVariableToEnv, type Environment } from "../../env";
import { getDocCommentLookupKey } from "../../doc/extractor";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  type Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import {
  isArrayType,
  isFunctionType,
  isFunctionTypeGeneric,
} from "../../types/guards";
import {
  prohibitVoidType,
  typeContainsRcType,
  typeProhibitsComptimeModifier,
  typeRequiresComptimeModifier,
  typeToString,
} from "../../types/utils";
import { VUnit } from "../../unit-value";
import { createUnknownValue, isTypeValue, isUnknownValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isValidVariableName } from "../utils";

export function evaluateBinding({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): { expr: FnCallExpr; variableExpr: Expr; variableName: string } {
  if (!exprIsFunctionCallOf(expr, ":", 2)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ":" for variable binding.`,
    });
  }
  let lhs = expr.args[0]!;
  const rhs = expr.args[1]!;

  // Evaluate the rhs expression
  const evaluatedRhs = evaluateExpression({
    expr: rhs,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedRhs.$) {
    throw formatErrorMessage({
      token: rhs.token,
      errorMessage: `Failed to evaluate rhs expression:
${exprToString(rhs)}`,
    });
  }
  env = evaluatedRhs.$.env;

  const typeValue = evaluatedRhs.$.value;
  if (!isTypeValue(typeValue)) {
    throw formatErrorMessage({
      token: rhs.token,
      errorMessage: `Expected type for rhs, got ${exprToString(rhs)}`,
    });
  }
  const userDefinedType = typeValue.value;

  // Prohibit array types with inferred length (_) in type annotations
  // Array length must be explicit or determined from initialization
  if (isArrayType(userDefinedType) && isUnknownValue(userDefinedType.length)) {
    throw formatErrorMessage({
      token: rhs.token,
      errorMessage: `Array type with inferred length '_' is not allowed in type annotations.
Use explicit length like 'Array(i32, 3)' or omit the type annotation and initialize with 'arr := Array(i32, _)(1, 2, 3)'`,
    });
  }

  // Prohibit the user defined type to be DST
  prohibitVoidType(userDefinedType, evaluatedRhs.token);

  // Evaluate the lhs expression
  let isCompileTimeOnly = false;
  let isImplicit = false;
  if (
    exprIsFunctionCall(lhs) &&
    exprIsFunctionCallOf(lhs, BuiltinKeywords.comptime)
  ) {
    isCompileTimeOnly = true;
    if (lhs.args.length !== 1) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected one argument for "comptime" , got ${lhs.args.length}`,
      });
    }
    lhs = lhs.args[0]!;
  }

  // Detect given(name) wrapper for implicit variable declaration
  if (
    exprIsFunctionCall(lhs) &&
    exprIsFunctionCallOf(lhs, BuiltinKeywords.given)
  ) {
    if (lhs.args.length !== 1) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected exactly one argument for "given", got ${lhs.args.length}`,
      });
    }
    isImplicit = true;
    isCompileTimeOnly = true;
    lhs = lhs.args[0]!;
  }

  isCompileTimeOnly =
    isCompileTimeOnly || context.forceCompileTimeBindings === true;

  if (
    !isCompileTimeOnly &&
    context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body" &&
    context.isEvaluatingFunctionBodyOrAsyncBlock?.type.return.isCompileTimeOnly
  ) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Unexpected runtime variable binding in a compile-time only function body.`,
    });
  }

  if (!isValidVariableName(lhs)) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Invalid binding to "${lhs.token.value}", expected identifier or operator`,
    });
  }

  if (
    typeRequiresComptimeModifier(userDefinedType, env) &&
    !isCompileTimeOnly
  ) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Expected "comptime" for compile-time known value binding:\n${typeToString(userDefinedType)}`,
    });
  }

  if (
    typeProhibitsComptimeModifier(userDefinedType, env) &&
    isCompileTimeOnly
  ) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Unexpected "comptime"  for ${typeToString(userDefinedType)} which can only be used at runtime.`,
    });
  }

  const variableName = lhs.token.value;

  // Validate that runtime variables with generic function types are prohibited
  // Generic functions can't be represented as runtime function pointers in C
  if (
    !isCompileTimeOnly &&
    isFunctionType(userDefinedType) &&
    isFunctionTypeGeneric(userDefinedType)
  ) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Runtime variables with generic function types are not allowed:
${typeToString(userDefinedType)}

Generic functions must be compile-time known to enable monomorphization. Consider using:
comptime(${variableName}) : ${typeToString(userDefinedType)}`,
    });
  }
  // Error on mutable runtime variables inside impl blocks.
  if (
    !isCompileTimeOnly &&
    !context.isEvaluatingFunctionBodyOrAsyncBlock &&
    context.isInsideImplBlock
  ) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Mutable runtime variable "${variableName}" is not allowed inside an impl block.
Use \`::\` for compile-time definitions inside impl.`,
    });
  }

  // Mark as module-level if we're NOT inside a function body — these become
  // C file-scope static variables accessible from all module functions.
  const isModuleLevel =
    !isCompileTimeOnly && !context.isEvaluatingFunctionBodyOrAsyncBlock;

  // Look up doc comment for this binding from the pre-computed lookup
  const docComment = context.docCommentLookup?.get(
    getDocCommentLookupKey(lhs.token)
  );

  // Add the variable to the env
  // console.log("(5) addVariableToEnv");
  const { env: nextEnv } = addVariableToEnv({
    env,
    variable: {
      name: variableName,
      type: userDefinedType,
      isCompileTimeOnly,
      value: isCompileTimeOnly
        ? [createUnknownValue(userDefinedType, { variableName, env, context })]
        : undefined,
      token: lhs.token,
      initializedAtToken: undefined, // The variable is not initialized yet
      consumedAtToken: undefined,
      isReassignable: true,
      isOwningTheRcValue: typeContainsRcType(userDefinedType),
      isImplicit,
      isModuleLevel,
      docComment,
    },
  });
  env = nextEnv;

  // Attach the user defined type to the lhs
  lhs.$ = {
    env,
    type: userDefinedType,
    pathCollection: [[variableName]],
  };

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };

  return { expr, variableExpr: lhs, variableName };
}
