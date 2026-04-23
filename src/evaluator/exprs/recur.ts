import { type Environment, popEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  type Expr,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { randomId } from "../../utils";
import {
  createUnknownValue,
  isFunctionValue,
  isUnknownValue,
} from "../../value";
import { evaluateFunctionCall } from "../calls/function";
import { tryToCallFunctionWithArguments } from "../calls/helper";
import type { EvaluatorContext } from "../context";

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
    //
    // We must also extract `deferredDropExpressions` and call
    // `attachTempVariableToExpr` so that callers (e.g. an outer function call
    // using `recur(...)` as an argument) hoist the result into a temp and
    // drop it. Without this, RC-typed return values from `recur` leak. See
    // issues/recur-call-result-not-hoisted-as-arg.md.
    const functionValue = context.isEvaluatingFunctionBodyOrAsyncBlock.value;
    const {
      returnType,
      runtimeArgExprsInOrder,
      callerEnv,
      deferredDropExpressions,
    } = tryToCallFunctionWithArguments({
      functionValue: isFunctionValue(functionValue) ? functionValue : undefined,
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

    // If the function being recurred is a runtime function (i.e., its return
    // type is not `comptime(...)`), mark the unknown result as
    // `isRuntimeOnly`. Otherwise overload resolution at the call site of
    // `recur(...)` may incorrectly prefer a comptime overload (e.g.
    // `comptime_not` over runtime `not` for `!recur(...)`), producing
    // malformed C with a 0-arg comptime function call.
    // See issues/recur-runtime-result-not-marked-runtime-only.md.
    const recurUnknown = createUnknownValue(returnType, {
      variableName: "recur_result_" + randomId(env.modulePath),
      env,
      context,
    });
    if (
      !isEvaluatingFunctionBodyOfType.return.isCompileTimeOnly &&
      isUnknownValue(recurUnknown)
    ) {
      recurUnknown.isRuntimeOnly = true;
    }

    expr.$ = {
      type: returnType,
      value: recurUnknown,
      env,
      pathCollection: [],
      runtimeArgExprsInOrder,
      deferredDropExpressions,
    };

    // Attach a temp variable to this recur expression so that callers using
    // `recur(...)` as an argument hoist its result into a named temp and emit
    // a drop. Without this, RC-typed return values leak.
    attachTempVariableToExpr(expr, true);

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
