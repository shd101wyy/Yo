import { Environment, popEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  createFunctionType,
  createModuleType,
  FunctionForallParameter,
  Type,
  typeOfType,
} from "../../types";
import { randomId } from "../../utils";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { evaluateFunctionParameters } from "./function";

/**
 * Evaluates the `Fn(params) -> ReturnType` syntax.
 * Creates a module type that represents a callable trait (similar to Rust's Fn trait).
 *
 * Example:
 *   Fn(x: i32, y: i32) -> i32
 *
 * This creates a module type with `isFn` set to the function signature.
 *
 * The Fn module can be used with:
 * - Impl(Fn(...) -> ...) for static dispatch with closures
 * - Dyn(Fn(...) -> ...) for dynamic dispatch
 */
export function evaluateFnModuleType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  // expr is the `->` expression with Fn(...) on the left and return type on the right
  if (!exprIsFunctionCallOf(expr, "->", 2)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected -> operator for Fn module type, got:\n${exprToString(expr)}`,
    });
  }

  const fnCallExpr = expr.args[0]!;
  const returnTypeExpr = expr.args[1]!;

  if (
    !exprIsFunctionCall(fnCallExpr) ||
    !exprIsFunctionCallOf(fnCallExpr, BuiltinKeywords.Fn)
  ) {
    throw formatErrorMessage({
      token: fnCallExpr.token,
      errorMessage: `Expected Fn(...) for function trait, got:\n${exprToString(fnCallExpr)}`,
    });
  }

  // Get the parameter expressions from Fn(...)
  const paramExprs = fnCallExpr.args;

  // Evaluate the parameters using the same logic as regular function types
  const {
    parameters,
    forallParameters,
    variadicParameter,
    env: envWithParams,
  } = evaluateFunctionParameters({
    parameterExprs: paramExprs,
    env,
    context: {
      ...context,
      isEvaluatingFunctionType: true,
    },
  });

  // Evaluate the return type
  const evaluatedReturnType = evaluateExpression({
    expr: returnTypeExpr,
    env: envWithParams,
    context: { ...context, isEvaluatingFunctionType: true },
  });

  if (!evaluatedReturnType.$) {
    throw formatErrorMessage({
      token: returnTypeExpr.token,
      errorMessage: `Failed to evaluate return type for Fn module.`,
    });
  }

  const returnTypeValue = evaluatedReturnType.$.value;
  let returnType: Type;
  if (isTypeValue(returnTypeValue)) {
    returnType = returnTypeValue.value;
  } else {
    throw formatErrorMessage({
      token: returnTypeExpr.token,
      errorMessage: `Expected a type for Fn return type, got:\n${exprToString(returnTypeExpr)}`,
    });
  }

  // Create the FunctionType that represents the Fn signature
  const fnType = createFunctionType({
    parameters,
    forallParameters: forallParameters as FunctionForallParameter[],
    variadicParameter,
    return_: {
      type: returnType,
      expr: returnTypeExpr,
      isCompileTimeOnly: false,
      isUnquote: false,
      label: `fn_return_${randomId()}`,
    },
    env: popEnvFrame(envWithParams, true),
    parametersFrame: envWithParams.frames[envWithParams.frames.length - 1]!,
    isClosure: true,
  });

  // Create the Fn module type
  const fnModuleType = createModuleType(popEnvFrame(envWithParams, true));

  // Set the isFn field to the function type
  fnModuleType.isFn = fnType;

  // Pop the environment frame (parameters are only for type evaluation)
  env = popEnvFrame(envWithParams, true);

  expr.$ = {
    env,
    type: typeOfType(fnModuleType),
    value: createTypeValue(fnModuleType),
    pathCollection: [],
  };

  return expr;
}
