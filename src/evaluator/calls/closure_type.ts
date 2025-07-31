import { transformFunctionBodyToCps } from "../../cps-transform";
import { Environment, popEnvFrame, pushEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import { cloneExpr, Expr, FuncCallExpr } from "../../expr";
import { FunctionValue } from "../../function-value";
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

  const closureBodyExpr = cloneExpr(argExprs[0]!);

  // Add parameters to the env new frame
  // For closures, we keep the full caller environment to enable variable capturing
  let env = pushEnvFrame(callerEnv, closureType.callType.parametersFrame);
  const originalEnv = env; // backup the env for later CPS transformation use.

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

  // Check if the closure uses `do` and apply CPS transformation
  if (
    evaluationContext.isEvaluatingFunctionBody?.usedDo &&
    evaluationContext.isEvaluatingFunctionBody?.usedDo.length > 0
  ) {
    console.log(`Closure uses 'do', applying CPS transformation...`);

    // Apply CPS transformation to the closure body
    const transformedBody = transformFunctionBodyToCps(
      closureBodyExpr,
      functionValue.funcId
    );

    // Store the transformed body separately
    functionValue.cpsTransformedBody = transformedBody;

    const {
      evaluationContext: freshEvaluationContext,
      capturedVariables: freshCapturedVariables,
    } = createFunctionBodyEvaluationContext(
      context,
      closureType.callType,
      functionValue,
      originalEnv
    );
    capturedVariables = freshCapturedVariables;

    // Re-evaluate the transformed body to ensure it's valid
    const evaluatedTransformedBody = evaluateBeginExpression({
      expr: transformedBody,
      env: originalEnv,
      context: freshEvaluationContext,
      variablesToAdd: [],
    });

    if (!evaluatedTransformedBody.$) {
      throw formatErrorMessage({
        token: closureBodyExpr.token,
        errorMessage: `Failed to evaluate the CPS-transformed closure body.`,
      });
    }

    console.log(
      `CPS transformation applied to closure ${functionValue.funcId}`
    );

    env = evaluatedTransformedBody.$.env;
  }

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
    isMutable: false,
    pathCollection:
      capturedVariables && capturedVariables.size > 0
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
  };

  return expr;
}
