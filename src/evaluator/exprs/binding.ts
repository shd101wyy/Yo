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
  prohibitVoidType,
  typeContainsRcType,
  typeProhibitsComptModifier,
  typeRequiresComptModifier,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { createUnknownValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
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

  // Prohibit the user defined type to be DST
  prohibitVoidType(userDefinedType, evaluatedRhs.token);

  // Evaluate the lhs expression
  let isCompileTimeOnly = false;
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

  const variableName = lhs.token.value;
  // Add the variable to the env
  // console.log("(5) addVariableToEnv");
  const { env: nextEnv } = addVariableToEnv({
    env,
    variable: {
      name: variableName,
      type: userDefinedType,
      isCompileTimeOnly,
      value: isCompileTimeOnly
        ? createUnknownValue(userDefinedType, variableName)
        : undefined,
      token: lhs.token,
      initializedAtToken: undefined, // The variable is not initialized yet
      consumedAtToken: undefined,
      isReassignable: true,
      isOwningTheRcValue: typeContainsRcType(userDefinedType),
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
