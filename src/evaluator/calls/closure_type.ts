import { Environment, popEnvFrame, pushEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, FuncCallExpr } from "../../expr";
import { FunctionValue } from "../../function-value";
import { areTypesCompatible, ClosureType, typeToString } from "../../types";
import { randomId } from "../../utils";
import { createClosureValue } from "../../value";
import { ValueTag } from "../../value-tag";
import { CapturedVariableInfo, EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
import {
  buildPathCollectionFromCapturedVariables,
  consumeCapturedVariables,
  createCaptureTypeAndValue,
  enrichCapturedVariables,
} from "../utils/closure";

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

  const closureBodyExpr = argExprs[0]!;

  // Add parameters to the env new frame
  // For closures, we keep the full caller environment to enable variable capturing
  let env = pushEnvFrame(callerEnv, closureType.callType.parametersFrame);

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
    SelfType: context.SelfType,
  };

  // Evaluate the closure body
  const capturedVariables = new Map<string, CapturedVariableInfo>();
  const evaluatedClosureBody = evaluateBeginExpression({
    expr: closureBodyExpr,
    env,
    context: {
      ...context,
      isExecuting: false, // We're analyzing the closure, not executing it
      isValidatingFunctionDefinition: true, // We're validating closure definition
      isEvaluatingFunctionBody: {
        type: closureType.callType,
        capturedVariables: capturedVariables,
        evaluationEnv: env, // Pass the current evaluation environment
      },
      expectedType: {
        type: closureType.callType.return.type,
        env: env,
      },
    },
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
      token: closureType.callType.return.expr.token,
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
      token: closureType.callType.return.expr.token,
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
  const { captureValue } = createCaptureTypeAndValue({
    expectedCaptureType: closureType.captureType,
    capturedVariablesWithValues,
    env: finalCallerEnv,
    closureToken: expr.token,
  });

  // Create the closure value
  const closureValue = createClosureValue(
    closureType, // Keep the original closure type
    captureValue,
    functionValue
  );

  // Set the result with the closure type
  expr.$ = {
    env: finalCallerEnv,
    value: closureValue,
    type: closureType,
    isMutable: false,
    pathCollection:
      capturedVariables && capturedVariables.size > 0
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
  };

  return expr;
}
