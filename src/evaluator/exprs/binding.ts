import { addVariableToEnv, Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  isTypeHierarchyType,
  prohibitDynamicSizedType,
  typeProhibitsComptModifier,
  typeRequiresComptModifier,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { createUnknownValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { isValidVariableName } from "../utils";

export function evaluateBinding({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): { expr: FuncCallExpr; variableExpr: Expr; variableName: string } {
  if (!exprIsFunctionCallOf(expr, ":", 2)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ":" for variable binding.`,
    });
  }
  let lhs = expr.args[0]!;
  const rhs = expr.args[1]!;

  // Evaluate the rhs expression
  const evaluatedRhs = context.evaluateExpression({
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

  // Prohibit the user defined type to be DST
  prohibitDynamicSizedType(userDefinedType, evaluatedRhs.token);

  // Evaluate the lhs expression
  let isCompileTimeOnly = false;
  let isMutable = false;
  let isImplicit = false;
  if (
    exprIsFunctionCall(lhs) &&
    exprIsFunctionCallOf(lhs, BuiltinKeywords.compt)
  ) {
    isCompileTimeOnly = true;
    if (lhs.args.length !== 1) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected one argument for "compt" , got ${lhs.args.length}`,
      });
    }
    lhs = lhs.args[0]!;
  }

  if (
    !isCompileTimeOnly &&
    context.isEvaluatingFunctionBody?.type.return.isCompileTimeOnly
  ) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Unexpected runtime variable binding in a compile-time only function body.`,
    });
  }

  if (
    exprIsFunctionCall(lhs) &&
    exprIsFunctionCallOf(lhs, BuiltinKeywords.given)
  ) {
    isImplicit = true;
    if (lhs.args.length !== 1) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected one argument for "given", got ${lhs.args.length}`,
      });
    }
    lhs = lhs.args[0]!;
  }

  if (
    exprIsFunctionCall(lhs) &&
    exprIsFunctionCallOf(lhs, BuiltinKeywords.mut)
  ) {
    isMutable = true;
    if (lhs.args.length !== 1) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected one argument for mut, got ${lhs.args.length}`,
      });
    }
    lhs = lhs.args[0]!;
  }
  if (!isValidVariableName(lhs)) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Invalid binding to "${lhs.token.value}", expected identifier or operator`,
    });
  }

  if (typeRequiresComptModifier(userDefinedType) && !isCompileTimeOnly) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Expected "compt"  for compile-time known value binding:\n${typeToString(userDefinedType)}`,
    });
  }

  if (typeProhibitsComptModifier(userDefinedType) && isCompileTimeOnly) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Unexpected "compt"  for ${typeToString(userDefinedType)} which can only be used at runtime.`,
    });
  }

  if (isTypeHierarchyType(userDefinedType) && isMutable) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Unexpected "mut" (or "!") for type hierarchy value binding. Type hierarchy values are immutable.`,
    });
  }

  /*
  // Check if it's effect handler
  if (isEffectFunctionType(userDefinedType)) {
    // convert it to a handler function
    if (!context.isEvaluatingFunctionBody) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Unexpected effect handler binding outside of a function body.`,
      });
    }
    const effectFunctionType = userDefinedType;
    const parentFunctionType = context.isEvaluatingFunctionBody.type;
    userDefinedType = createEffectHandlerType(
      effectFunctionType,
      parentFunctionType,
      env
    );
    console.log("effect handler type", typeToString(userDefinedType));
  }
  */

  const variableName = lhs.token.value;
  // Add the variable to the env
  // console.log("(5) addVariableToEnv");
  const { env: nextEnv } = addVariableToEnv({
    env,
    variable: {
      name: variableName,
      type: userDefinedType,
      isMutable,
      isCompileTimeOnly,
      isImplicit,
      value: isCompileTimeOnly
        ? createUnknownValue(userDefinedType)
        : undefined,
      token: lhs.token,
      initializedAtToken: undefined, // The variable is not initialized yet
      consumedAtToken: undefined,
    },
  });
  env = nextEnv;

  // Attach the user defined type to the lhs
  lhs.$ = {
    env,
    type: userDefinedType,
    isMutable,
    pathCollection: [[variableName]],
  };

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    isMutable: false,
    pathCollection: [],
  };

  return { expr, variableExpr: lhs, variableName };
}
