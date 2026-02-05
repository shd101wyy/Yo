import { Environment, popEnvFrame, pushEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  cloneExpr,
  Expr,
  FnCallExpr,
} from "../../expr";
import { FunctionValue } from "../../function-value";
import { areTypesCompatible } from "../../types/compatibility";
import { DynType, FnTraitType, SomeType, Type } from "../../types/definitions";
import { isDynType, isSomeType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import { randomId } from "../../utils";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
import { applyWhereClauseConstraints } from "../types/function";
import {
  buildPathCollectionFromCapturedVariables,
  createCaptureTypeAndValue,
  enrichCapturedVariables,
  generateCapturedVariableDupExpressions,
} from "../utils/closure";
import { createFunctionBodyEvaluationContext } from "./function-type";

/**
 * Handle calling a closure type to create a closure value.
 * expr should be: WrapperType(closureBody) where WrapperType is SomeType or DynType containing a FnTraitType
 */
export function tryToImplementClosureByFnModuleType({
  expr,
  fnModuleType,
  wrapperType,
  callerEnv,
  context,
}: {
  expr: FnCallExpr;
  fnModuleType: FnTraitType;
  wrapperType: SomeType | DynType;
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
  let env = pushEnvFrame(callerEnv, fnModuleType.isFn.callType.parametersFrame);
  // const originalEnv = env; // backup the env for later CPS transformation use.

  // Re-apply where-clause constraints for this closure body evaluation.
  if (fnModuleType.isFn.callType.whereClauseExprs?.length) {
    const constraintExprs = fnModuleType.isFn.callType.whereClauseExprs.map(
      (whereClauseExpr) => cloneExpr(whereClauseExpr)
    );
    const result = applyWhereClauseConstraints({
      constraintExprs,
      env,
      context: {
        ...context,
        isEvaluatingFunctionType: true,
      },
    });
    env = result.env;
  }

  // Create the function value for the closure
  const functionValue: FunctionValue = {
    tag: ValueTag.Function,
    type: fnModuleType.isFn.callType, // The function value uses the isFn type
    body: closureBodyExpr,
    frameLevel: env.frames.length - 1,
    funcName: undefined,
    funcId: `closure_${randomId(env.modulePath)}`,
    calledComptimeFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Create evaluation context using helper function
  const { evaluationContext } = createFunctionBodyEvaluationContext(
    context,
    fnModuleType.isFn.callType,
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
      { type: fnModuleType.isFn.callType.return.type, env },
      { type: closureBodyReturnType, env }
    )
  ) {
    throw formatErrorMessage({
      token: fnModuleType.isFn.callType.return.typeExpr.token,
      errorMessage: `Incompatible closure return type:
- Expected: ${typeToString(fnModuleType.isFn.callType.return.type)}
- Given  : ${typeToString(closureBodyReturnType)}`,
    });
  }

  if (
    fnModuleType.isFn.callType.return.isCompileTimeOnly &&
    !evaluatedClosureBody.$.value
  ) {
    throw formatErrorMessage({
      token: fnModuleType.isFn.callType.return.typeExpr.token,
      errorMessage: `Expected to return a compile-time value, but got runtime value.`,
    });
  }

  // Pop the env frame
  // NOTE: We need to ignore check here because the top frame might contain tempVariable holding the return value.
  //       The check should be handled when evaluating the begin expression.
  env = popEnvFrame(env, true);

  // Update the function value with captured variables (if any)
  // NOTE: Use callerEnv (BEFORE consumption) so we can access the variables
  const capturedVariablesWithValues =
    capturedVariables && capturedVariables.size > 0
      ? enrichCapturedVariables({ capturedVariables, env: callerEnv })
      : undefined;

  // Generate ___dup expressions for captured ARC variables
  // The closure gets its own copy through the dup, the original variable remains usable
  let finalCallerEnv = callerEnv;
  const { capturedVariableDupExpressions, env: updatedEnv } =
    generateCapturedVariableDupExpressions({
      capturedVariablesWithValues,
      env: callerEnv,
      context,
    });
  finalCallerEnv = updatedEnv;

  // Create the proper capture type based on captured variables using helper function
  // We don't need the captureValue since closures are runtime-only
  const { captureType: inferredCaptureType } = createCaptureTypeAndValue({
    expectedCaptureType: undefined, // Capture type is no longer part of ClosureType
    capturedVariablesWithValues,
    env: finalCallerEnv,
    closureToken: expr.token,
    context: { ...context },
  });

  // Set the closure info on the function value for easy codegen access
  functionValue.closureInfo = {
    closureType: fnModuleType,
    captureType: inferredCaptureType,
  };

  // Determine the final type based on the wrapper type (SomeType or DynType)
  let finalType: Type;
  if (isSomeType(wrapperType)) {
    // IMPORTANT: Mutate the wrapper SomeType in-place so downstream generic specialization
    // can observe the concrete capture struct type.
    //
    // This mutation is safe because we use `skipSpecialization: true` during the "checking phase"
    // of function call resolution (when tryToCallFunctionWithArguments is called with cloned
    // expressions to test if parameters match). This prevents cache pollution from intermediate
    // capture structs created during checking. The actual specialization only happens during
    // the real call phase with the final capture struct.
    //
    // See issues/SPECIALIZATION_CACHE_PITFALL.md for details on the bug this pattern caused.
    wrapperType.resolvedConcreteType = inferredCaptureType;
    finalType = {
      ...wrapperType,
      resolvedConcreteType: inferredCaptureType,
    } as SomeType;
  } else if (isDynType(wrapperType)) {
    // For DynType (Dyn(Fn(...))), no need to do anything
    finalType = wrapperType;
  } else {
    // Fallback (should not happen)
    finalType = fnModuleType;
  }

  // Set the result with the wrapper type (SomeType or DynType)
  expr.$ = {
    env: finalCallerEnv,
    value: undefined,
    type: finalType,
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
  // Only attach for DynType since SomeType is a value type (not reference counted)
  if (isDynType(wrapperType)) {
    attachTempVariableToExpr(expr, true);
  }

  return expr;
}
