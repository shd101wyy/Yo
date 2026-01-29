import { Environment, popEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import { createUnknownValue, isFunctionValue } from "../../value";
import { evaluateFunctionCall } from "../calls/function";
import { tryToCallFunctionWithArguments } from "../calls/helper";
import { EvaluatorContext } from "../context";

export function evaluateRecur({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  if (context.isEvaluatingFunctionBodyOrAsyncBlock?.kind !== "function-body") {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected a function type for recur, got:\n${exprToString(expr)}`,
    });
  }

  const isEvaluatingFunctionBodyOfType =
    context.isEvaluatingFunctionBodyOrAsyncBlock.type;

  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected recur, got:\n${exprToString(expr)}`,
    });
  }

  // During CTFE capability analysis (isAnalyzingCtfeCapability is true), we short-circuit recur
  // to avoid infinite recursion. We just return an UnknownValue of the return type
  // since we're only checking that the function CAN be evaluated at compile time,
  // not actually computing the result with unknown values.
  //
  // Also short-circuit during function definition validation (isValidatingFunctionDefinition)
  // to avoid infinite recursion when type-checking recursive functions.
  if (
    context.isAnalyzingCtfeCapability ||
    context.isValidatingFunctionDefinition
  ) {
    // Use tryToCallFunctionWithArguments with skipCtfeExecution to properly:
    // 1. Type-check arguments against function parameters
    // 2. Handle compile-time vs runtime parameters correctly
    // 3. Populate runtimeArgExprsInOrder for codegen
    // 4. Skip actual CTFE execution to avoid infinite recursion
    const functionValue = context.isEvaluatingFunctionBodyOrAsyncBlock.value;
    const { returnType, runtimeArgExprsInOrder, callerEnv } =
      tryToCallFunctionWithArguments({
        functionValue: isFunctionValue(functionValue)
          ? functionValue
          : undefined,
        functionType: isEvaluatingFunctionBodyOfType,
        expr,
        functionCalleeExpr: expr.func,
        argExprs: expr.args,
        callerEnv: env,
        context,
        isMethodCall: false,
        skipSpecialization: true, // Don't create specialized versions during validation
        skipCtfeExecution: true, // Skip CTFE execution to avoid infinite recursion
      });

    env = popEnvFrame(callerEnv);

    expr.$ = {
      type: returnType,
      value: createUnknownValue(returnType, "recur_result"),
      env,
      pathCollection: [],
      runtimeArgExprsInOrder,
    };
    return expr;
  }

  const evaluatedRecurExpr = evaluateFunctionCall({
    expr: expr,
    env,
    givenFunc: {
      type: isEvaluatingFunctionBodyOfType,
      value: context.isEvaluatingFunctionBodyOrAsyncBlock.value ?? undefined,
    },
    context: { ...context },
  });

  return evaluatedRecurExpr;
}
