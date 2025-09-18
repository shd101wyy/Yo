import { Environment, popEnvFrame, pushEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, FuncCallExpr } from "../../expr";
import { FunctionValue } from "../../function-value";
import { PlaceholderToken } from "../../token";
import {
  areTypesCompatible,
  ClosureType,
  createClosureType,
  isSomeType,
  typeToString,
} from "../../types";
import { randomId } from "../../utils";
import { createClosureValue } from "../../value";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
import { addARCFunctionsToClosureType } from "../types/utils";
import {
  buildPathCollectionFromCapturedVariables,
  consumeCapturedVariables,
  createCaptureTypeAndValue,
  enrichCapturedVariables,
} from "../utils/closure";
import { createFunctionBodyEvaluationContext } from "./function_type";

/**
 * Handle calling a closure type to create a closure value.
 * expr should be: ClosureType(closureBody)
 */
export function tryToImplementClosureByClosureType({
  expr,
  closureType,
  callerEnv,
  context,
}: {
  expr: FuncCallExpr;
  closureType: ClosureType;
  callerEnv: Environment;
  context: EvaluatorContext;
}): Expr {
  const closureTypeExpr = expr.func;
  const argExprs = expr.args;

  if (argExprs.length !== 1) {
    throw formatErrorMessage({
      token: closureTypeExpr.token,
      errorMessage: `Closure type expects exactly 1 argument (the closure body), got ${argExprs.length}`,
    });
  }

  // NOTE: Don't cloneExpr here. It will affect the vscode extension.
  const closureBodyExpr = argExprs[0]!;

  // Add parameters to the env new frame
  // For closures, we keep the full caller environment to enable variable capturing
  let env = pushEnvFrame(callerEnv, closureType.callType.parametersFrame);
  // const originalEnv = env; // backup the env for later CPS transformation use.

  // Create the function value for the closure
  const functionValue: FunctionValue = {
    tag: ValueTag.Function,
    type: closureType.callType, // The function value uses the call type
    body: closureBodyExpr,
    frameLevel: env.frames.length - 1,
    funcName: undefined,
    funcId: `closure_${randomId()}`,
    calledComptFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Create evaluation context using helper function
  // eslint-disable-next-line prefer-const
  let { evaluationContext, capturedVariables } =
    createFunctionBodyEvaluationContext(
      context,
      closureType.callType,
      functionValue,
      env
    );

  // Evaluate the closure body
  const evaluatedClosureBody = evaluateBeginExpression({
    expr: closureBodyExpr,
    env,
    context: evaluationContext,
    variablesToAdd: [],
  });

  if (!evaluatedClosureBody.$) {
    throw formatErrorMessage({
      token: closureBodyExpr.token,
      errorMessage: `Failed to evaluate the closure body.`,
    });
  }
  env = evaluatedClosureBody.$.env;

  // Check if the closure body type matches the closure return type
  const closureBodyReturnType = evaluatedClosureBody.$.type;
  if (
    !areTypesCompatible(
      { type: closureType.callType.return.type, env },
      { type: closureBodyReturnType, env }
    )
  ) {
    throw formatErrorMessage({
      token: closureType.callType.return.expr?.token ?? PlaceholderToken,
      errorMessage: `Incompatible closure return type:
- Expected: ${typeToString(closureType.callType.return.type)}
- Given  : ${typeToString(closureBodyReturnType)}`,
    });
  }

  if (
    closureType.callType.return.isCompileTimeOnly &&
    !evaluatedClosureBody.$.value
  ) {
    throw formatErrorMessage({
      token: closureType.callType.return.expr?.token ?? PlaceholderToken,
      errorMessage: `Expected to return a compile-time value, but got runtime value.`,
    });
  }

  // Pop the env frame
  env = popEnvFrame(env);

  // For closures, consume the captured variables from outer scopes
  let finalCallerEnv = callerEnv;
  if (capturedVariables && capturedVariables.size > 0) {
    finalCallerEnv = consumeCapturedVariables({
      capturedVariables,
      env: callerEnv,
      closureToken: expr.token,
    });
  }

  // Update the function value with captured variables (if any)
  const capturedVariablesWithValues =
    capturedVariables && capturedVariables.size > 0
      ? enrichCapturedVariables({ capturedVariables, env: finalCallerEnv })
      : undefined;

  if (capturedVariablesWithValues) {
    functionValue.capturedVariables = capturedVariablesWithValues;
  }

  // Create the proper capture value based on captured variables using helper function
  const { captureType: inferredCaptureType, captureValue } =
    createCaptureTypeAndValue({
      expectedCaptureType: closureType.captureType,
      capturedVariablesWithValues,
      env: finalCallerEnv,
      closureToken: expr.token,
    });

  // Update closure type with the inferred capture type if it was inferred
  const finalClosureType =
    isSomeType(closureType.captureType) && !isSomeType(inferredCaptureType)
      ? createClosureType(
          closureType.callType,
          inferredCaptureType,
          finalCallerEnv
        )
      : closureType;

  // Add ARC functions to the closure type
  finalCallerEnv = addARCFunctionsToClosureType({
    closureType: finalClosureType,
    env: finalCallerEnv,
    context,
  });

  // Create the closure value
  const closureValue = createClosureValue(
    finalClosureType, // Use the updated closure type with inferred capture type
    captureValue,
    functionValue
  );

  // Set the result with the closure type
  expr.$ = {
    env: finalCallerEnv,
    value: closureValue,
    type: finalClosureType, // Use the updated closure type
    pathCollection:
      capturedVariables && capturedVariables.size > 0
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
  };

  return expr;
}
