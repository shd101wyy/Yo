import { Environment, popEnvFrame, pushEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import { attachTempVariableToExpr, Expr, FuncCallExpr } from "../../expr";
import { FunctionValue } from "../../function-value";
import { PlaceholderToken } from "../../token";
import { areTypesCompatible, FnModuleType, typeToString } from "../../types";
import { randomId } from "../../utils";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
import {
  buildPathCollectionFromCapturedVariables,
  consumeCapturedVariables,
  createCaptureTypeAndValue,
  enrichCapturedVariables,
  generateCapturedVariableDupExpressions,
} from "../utils/closure";
import { createFunctionBodyEvaluationContext } from "./function_type";

/**
 * Handle calling a closure type to create a closure value.
 * expr should be: FnModuleType(closureBody)
 */
export function tryToImplementClosureByFnModuleType({
  expr,
  fnModuleType,
  callerEnv,
  context,
}: {
  expr: FuncCallExpr;
  fnModuleType: FnModuleType;
  callerEnv: Environment;
  context: EvaluatorContext;
}): Expr {
  const fnModuleTypeExpr = expr.func;
  const argExprs = expr.args;

  if (argExprs.length !== 1) {
    throw formatErrorMessage({
      token: fnModuleTypeExpr.token,
      errorMessage: `Fn module type expects exactly 1 argument (the closure body), got ${argExprs.length}`,
    });
  }

  // NOTE: Don't cloneExpr here. It will affect the vscode extension.
  const closureBodyExpr = argExprs[0]!;

  // Add parameters to the env new frame
  // For closures, we keep the full caller environment to enable variable capturing
  let env = pushEnvFrame(callerEnv, fnModuleType.isFn.parametersFrame);
  // const originalEnv = env; // backup the env for later CPS transformation use.

  // Create the function value for the closure
  const functionValue: FunctionValue = {
    tag: ValueTag.Function,
    type: fnModuleType.isFn, // The function value uses the isFn type
    body: closureBodyExpr,
    frameLevel: env.frames.length - 1,
    funcName: undefined,
    funcId: `closure_${randomId()}`,
    calledComptFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Create evaluation context using helper function
  const { evaluationContext } = createFunctionBodyEvaluationContext(
    context,
    fnModuleType.isFn,
    functionValue,
    env
  );

  // Evaluate the closure body
  const evaluatedClosureBody = evaluateBeginExpression({
    expr: closureBodyExpr,
    env,
    context: evaluationContext,
    variablesToAdd: [],
    isEvaluatingFunctionBodyBeginBlock: true,
  });

  if (!evaluatedClosureBody.$) {
    throw formatErrorMessage({
      token: closureBodyExpr.token,
      errorMessage: `Failed to evaluate the closure body.`,
    });
  }
  env = evaluatedClosureBody.$.env;

  // Get captured variables from the evaluation context
  const capturedVariables = evaluationContext.capturedVariables;

  // Check if the closure body type matches the closure return type
  const closureBodyReturnType = evaluatedClosureBody.$.type;
  if (
    !areTypesCompatible(
      { type: fnModuleType.isFn.return.type, env },
      { type: closureBodyReturnType, env }
    )
  ) {
    throw formatErrorMessage({
      token: fnModuleType.isFn.return.expr?.token ?? PlaceholderToken,
      errorMessage: `Incompatible closure return type:
- Expected: ${typeToString(fnModuleType.isFn.return.type)}
- Given  : ${typeToString(closureBodyReturnType)}`,
    });
  }

  if (
    fnModuleType.isFn.return.isCompileTimeOnly &&
    !evaluatedClosureBody.$.value
  ) {
    throw formatErrorMessage({
      token: fnModuleType.isFn.return.expr?.token ?? PlaceholderToken,
      errorMessage: `Expected to return a compile-time value, but got runtime value.`,
    });
  }

  // Pop the env frame
  // NOTE: We need to ignore check here because the top frame might contain tempVariable holding the return value.
  //       The check should be handled when evaluating the begin expression.
  env = popEnvFrame(env, true);

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

  // Create the proper capture type based on captured variables using helper function
  // We don't need the captureValue since closures are runtime-only
  const { captureType: inferredCaptureType } = createCaptureTypeAndValue({
    expectedCaptureType: undefined, // Capture type is no longer part of ClosureType
    capturedVariablesWithValues,
    env: finalCallerEnv,
    closureToken: expr.token,
    context: { ...context },
  });

  // The FnModuleType is already created with the correct isFn
  const finalFnModuleType = fnModuleType;

  // Generate ___dup expressions for captured ARC variables
  const { capturedVariableDupExpressions, env: updatedEnv } =
    generateCapturedVariableDupExpressions({
      capturedVariablesWithValues,
      env: finalCallerEnv,
      context,
    });
  finalCallerEnv = updatedEnv;

  // Set the closure info on the function value for easy codegen access
  functionValue.closureInfo = {
    closureType: finalFnModuleType,
    captureType: inferredCaptureType,
  };

  // Set the result with the FnModuleType
  expr.$ = {
    env: finalCallerEnv,
    value: undefined,
    type: finalFnModuleType, // Use the FnModuleType
    pathCollection:
      capturedVariables && capturedVariables.size > 0
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
    deferredDupExpressions:
      capturedVariableDupExpressions &&
      capturedVariableDupExpressions.length > 0
        ? capturedVariableDupExpressions
        : undefined,
    captureType: inferredCaptureType, // Store the capture struct type for codegen (used for both closures and async blocks)
    closureFunctionValue: functionValue,
  };

  // Attach a temp variable to the expr to hold the ARC value for closure
  attachTempVariableToExpr(expr, true);

  return expr;
}
