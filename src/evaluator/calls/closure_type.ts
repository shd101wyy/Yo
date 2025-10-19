import { Environment, popEnvFrame, pushEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import { attachTempVariableToExpr, Expr, FuncCallExpr } from "../../expr";
import { FunctionValue } from "../../function-value";
import { PlaceholderToken } from "../../token";
import {
  areTypesCompatible,
  ClosureType,
  createClosureType,
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
  generateCapturedVariableDupExpressions,
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
  const { evaluationContext } = createFunctionBodyEvaluationContext(
    context,
    closureType.callType,
    functionValue,
    env
  );

  // DEBUG: Check if closure tracking is enabled
  console.log(
    `[DEBUG] closure_type.ts - closureType.callType.isClosure:`,
    closureType.callType.isClosure
  );
  console.log(
    `[DEBUG] closure_type.ts - evaluationContext.capturedVariables:`,
    evaluationContext.capturedVariables !== undefined
      ? "Map exists"
      : "undefined"
  );
  console.log(
    `[DEBUG] closure_type.ts - Before evaluation, capturedVariables size:`,
    evaluationContext.capturedVariables?.size || "undefined"
  );

  // Evaluate the closure body
  console.log(
    `[DEBUG] closure_type.ts - BEFORE evaluateBeginExpression, capturedVariables:`,
    evaluationContext.capturedVariables?.size || "undefined"
  );

  const evaluatedClosureBody = evaluateBeginExpression({
    expr: closureBodyExpr,
    env,
    context: evaluationContext,
    variablesToAdd: [],
  });

  console.log(
    `[DEBUG] closure_type.ts - AFTER evaluateBeginExpression, capturedVariables:`,
    evaluationContext.capturedVariables?.size || "undefined"
  );

  if (!evaluatedClosureBody.$) {
    throw formatErrorMessage({
      token: closureBodyExpr.token,
      errorMessage: `Failed to evaluate the closure body.`,
    });
  }
  env = evaluatedClosureBody.$.env;

  // Get captured variables from the evaluation context
  const capturedVariables = evaluationContext.capturedVariables;

  // DEBUG: Check captured variables after evaluation
  console.log(
    `[DEBUG] closure_type.ts - After evaluation, capturedVariables:`,
    capturedVariables?.size || "undefined"
  );
  if (capturedVariables) {
    console.log(
      `[DEBUG] closure_type.ts - Captured variable names:`,
      Array.from(capturedVariables.keys())
    );
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

  // DEBUG: Log captured variables state
  console.log(
    `[DEBUG] closure_type.ts - capturedVariables:`,
    capturedVariables?.size || "undefined"
  );
  console.log(
    `[DEBUG] closure_type.ts - capturedVariablesWithValues:`,
    capturedVariablesWithValues?.size || "undefined"
  );

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
      context: { ...context },
    });

  // Update closure type with the inferred capture type if it was inferred
  const finalClosureType =
    closureType.captureType === undefined && inferredCaptureType !== undefined
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

  // Generate ___dup expressions for captured ARC variables
  const { capturedVariableDupExpressions, env: updatedEnv } =
    generateCapturedVariableDupExpressions({
      capturedVariablesWithValues,
      env: finalCallerEnv,
      context,
    });
  finalCallerEnv = updatedEnv;

  // Set the result with the closure type
  expr.$ = {
    env: finalCallerEnv,
    value: closureValue,
    type: finalClosureType, // Use the updated closure type
    pathCollection:
      capturedVariables && capturedVariables.size > 0
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
    capturedVariableDupExpressions:
      capturedVariableDupExpressions &&
      capturedVariableDupExpressions.length > 0
        ? capturedVariableDupExpressions
        : undefined,
  };

  // Attach a temp variable to the expr to hold the ARC value for closure
  attachTempVariableToExpr(expr, true);

  return expr;
}
