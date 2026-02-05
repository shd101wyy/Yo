import {
  addVariableToEnv,
  Environment,
  keepTopLevelFrameAndComptimeVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import { cloneExpr, Expr, FnCallExpr } from "../../expr";
import { FunctionValue } from "../../function-value";
import { PlaceholderToken } from "../../token";
import { areTypesCompatible } from "../../types/compatibility";
import { FunctionType } from "../../types/definitions";
import { isFunctionType, isSomeType } from "../../types/guards";
import { typeContainsSomeType, typeToString } from "../../types/utils";
import { randomId } from "../../utils";
import { createUnknownValue } from "../../value";
import { ValueTag } from "../../value-tag";
import {
  CapturedVariableInfo,
  EvaluatorContext,
  FunctionEvaluationContext,
} from "../context";
import { analyzeCtfeCapability } from "../ctfe/ctfe-analysis";
import { evaluateBeginExpression } from "../exprs/begin";
import { applyWhereClauseConstraints } from "../types/function";
import {
  buildPathCollectionFromCapturedVariables,
  consumeCapturedVariables,
} from "../utils/closure";

/**
 * Creates a fresh evaluation context for function body evaluation
 */
export function createFunctionBodyEvaluationContext(
  context: EvaluatorContext,
  functionType: FunctionType,
  functionValue: FunctionValue,
  env: Environment
): {
  evaluationContext: EvaluatorContext;
  functionBodyContext: FunctionEvaluationContext;
} {
  const functionBodyContext: FunctionEvaluationContext = {
    kind: "function-body",
    type: functionType,
    value: functionValue,
    evaluationEnv: env,
  };

  // Create captured variables map for tracking variable captures
  // This is always created since we determine closure behavior from context
  const capturedVariables = context.capturedVariables
    ? context.capturedVariables
    : new Map<string, CapturedVariableInfo>();

  const evaluationContext: EvaluatorContext = {
    ...context,
    isExecuting: false, // We're analyzing, not executing
    isValidatingFunctionDefinition: true, // We're validating function definition
    isEvaluatingFunctionBodyOrAsyncBlock: functionBodyContext,
    isEvaluatingFunctionType: false,
    isEvaluatingLoopBody: undefined, // Clear loop body context for function body
    capturedVariables, // Set the captured variables map here
    expectedType: {
      type: functionType.return.type,
      env: env,
    },
    functionReturnImplConcreteType: [], // Empty array for each function

    // Clear CTFE
    forceCompileTimeBindings: false,
    isAnalyzingCtfeCapability: false,
  };

  return { evaluationContext, functionBodyContext };
}

/**
 * expr should be the:
 * functionType(functionBody);
 * Please note this is for regular functions only, closures are handled in closure_type.ts
 */
export function tryToImplementFunctionByFunctionType({
  expr,
  functionType,
  callerEnv,
  context,
}: {
  expr: FnCallExpr;
  functionType: FunctionType;
  callerEnv: Environment;
  context: EvaluatorContext;
}): Expr {
  const functionTypeExpr = expr.func;
  const argExprs = expr.args;
  if (argExprs.length !== 1) {
    throw formatErrorMessage({
      token: functionTypeExpr.token,
      errorMessage: `Failed to implement the function. Expected 1 argument for the function body, got ${argExprs.length}.`,
    });
  }
  // NOTE: Don't cloneExpr here. It will affect the vscode extension.
  const functionBodyExpr = argExprs[0]!;

  // Add parameters to the env new frame
  // Regular functions (defined with `::`) do NOT capture outer variables.
  // Only closures (defined with `=>`) track captures. So we always treat this as
  // a non-closure context and clear any inherited capturedVariables.
  const isInClosureContext = false;

  // Check if we need to set up parameter aliases
  // This happens when implementing a module trait method where the function type
  // has different parameter names than the expected type from the trait
  const expectedType = context.expectedType?.type;
  const needsParameterAliasing =
    expectedType &&
    isFunctionType(expectedType) &&
    expectedType.parameters.length === functionType.parameters.length &&
    expectedType.parameters.some(
      (expectedParam, i) =>
        expectedParam.label !== functionType.parameters[i]!.label
    );

  let env = pushEnvFrame(
    // For closures, we keep the full caller environment to enable variable capturing
    // For regular functions, we only keep top-level frame and compile-time variables
    isInClosureContext
      ? callerEnv
      : keepTopLevelFrameAndComptimeVariablesFromEnv(callerEnv)
  );

  // If we need parameter aliasing, manually add parameters with aliases
  // Otherwise use the functionType.parametersFrame directly
  if (needsParameterAliasing && expectedType && isFunctionType(expectedType)) {
    // Add forall parameters first (they must match exactly)
    for (const forallParam of functionType.forallParameters) {
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: forallParam.label,
          type: forallParam.type,
          isCompileTimeOnly: true,
          value: [
            createUnknownValue(forallParam.type, {
              variableName: forallParam.label,
              env,
              context,
            }),
          ],
          token: PlaceholderToken,
          initializedAtToken: PlaceholderToken,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
      });
      env = nextEnv;
    }

    // Add regular parameters with aliases
    for (let i = 0; i < functionType.parameters.length; i++) {
      const anonymousParam = functionType.parameters[i]!;
      const expectedParam = expectedType.parameters[i]!;
      const anonymousParamName = anonymousParam.label;
      const expectedParamName = expectedParam.label;

      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: anonymousParamName,
          type: anonymousParam.type,
          isCompileTimeOnly: anonymousParam.isCompileTimeOnly,
          value: anonymousParam.isCompileTimeOnly
            ? [
                createUnknownValue(anonymousParam.type, {
                  variableName: expectedParamName,
                  env,
                  context,
                }),
              ]
            : undefined,
          token: PlaceholderToken,
          initializedAtToken: PlaceholderToken,
          consumedAtToken: undefined,
          isOwningTheRcValue: anonymousParam.isOwningTheRcValue,
          // Set up parameter alias if names differ
          parameterAlias:
            anonymousParamName !== expectedParamName
              ? expectedParamName
              : undefined,
        },
      });
      env = nextEnv;
    }
  } else {
    // No aliasing needed, use the functionType.parametersFrame directly
    env = pushEnvFrame(env, functionType.parametersFrame);
  }
  // const originalEnv = env; // backup the env for later CPS transformation use.

  // Get the parameters frame that was just created
  const parametersFrame = env.frames[env.frames.length - 1]!;

  // Create new function type with the correct parametersFrame
  // Keep the original parameter names (not the expected names) because the
  // function body uses the original parameter names for variable references
  const newFunctionType: FunctionType = {
    ...functionType,
    parametersFrame,
    env: functionType.env,
  };

  // Create the function value
  const functionValue: FunctionValue = {
    tag: ValueTag.Function,
    type: newFunctionType,
    body: functionBodyExpr, // Use transformed body
    frameLevel: env.frames.length - 1,
    funcName: undefined,
    funcId: `fn_${randomId(env.modulePath)}`,
    calledComptimeFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Check if the function has forall type parameters
  // Re-apply where-clause constraints for this function body evaluation.
  if (newFunctionType.whereClauseExprs?.length) {
    const constraintExprs = newFunctionType.whereClauseExprs.map(
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
  // If the function depends on generic type variables, we should NOT evaluate the body
  // at definition time. The body will be evaluated when the function is specialized
  // with concrete type arguments.
  const shouldDeferBodyEvaluation =
    newFunctionType.forallParameters.length > 0 ||
    newFunctionType.parameters.some((param) =>
      typeContainsSomeType(param.type)
    ) ||
    (newFunctionType.SelfType &&
      typeContainsSomeType(newFunctionType.SelfType));

  let evaluatedFunctionBody: Expr;
  let evaluationContext: EvaluatorContext;

  if (shouldDeferBodyEvaluation) {
    // Don't evaluate the body for generic functions
    // Just attach the environment for later use when called
    functionBodyExpr.$ = {
      env,
      type: functionType.return.type,
      value: functionType.return.isCompileTimeOnly
        ? createUnknownValue(functionType.return.type, {
            variableName: "function_body",
            env,
            context,
          })
        : undefined,
      pathCollection: [],
    };
    // Create a minimal evaluation context for generic functions
    evaluationContext = {
      ...context,
      capturedVariables: undefined,
    };
    evaluatedFunctionBody = functionBodyExpr;
  } else {
    // Create a mutable context that we can check after evaluation
    // For regular functions (not closures), we clear capturedVariables to prevent
    // outer variables from being incorrectly marked as captured/consumed.
    const ctx = createFunctionBodyEvaluationContext(
      { ...context, capturedVariables: undefined },
      newFunctionType,
      functionValue,
      env
    );
    evaluationContext = ctx.evaluationContext;

    evaluatedFunctionBody = evaluateBeginExpression({
      expr: functionBodyExpr, // Use transformed body
      env,
      context: evaluationContext,
      variablesToAdd: [],
      isEvaluatingFunctionBodyBeginBlock: true,
    });
    if (!evaluatedFunctionBody.$) {
      throw formatErrorMessage({
        token: functionBodyExpr.token,
        errorMessage: `Failed to evaluate the function body.`,
      });
    }
    env = evaluatedFunctionBody.$.env;
  }

  // Get captured variables from the evaluation context
  const capturedVariables = evaluationContext.capturedVariables;

  // Check if the function body type matches the function return type
  const functionBodyReturnType = evaluatedFunctionBody.$?.type;

  // Regular function: body type must match return type exactly
  if (
    functionBodyReturnType &&
    !areTypesCompatible(
      { type: newFunctionType.return.type, env },
      { type: functionBodyReturnType, env }
    )
  ) {
    // console.trace();
    throw formatErrorMessage({
      token: newFunctionType.return.expr?.token ?? PlaceholderToken,
      errorMessage: `Incompatible function return type for:
- Expected: ${typeToString(newFunctionType.return.type)}
- Given  : ${typeToString(functionBodyReturnType)}`,
    });
  }

  // If the return type is a SomeType (Impl) without resolvedConcreteType,
  // and the function body returns a concrete type that implements the required modules,
  // set the resolvedConcreteType for proper codegen
  if (
    isSomeType(newFunctionType.return.type) &&
    !newFunctionType.return.type.resolvedConcreteType &&
    !isSomeType(functionBodyReturnType)
  ) {
    newFunctionType.return.type.resolvedConcreteType = functionBodyReturnType;
  }

  if (
    newFunctionType.return.isCompileTimeOnly &&
    evaluatedFunctionBody.$ &&
    !evaluatedFunctionBody.$.value
  ) {
    throw formatErrorMessage({
      token: newFunctionType.return.expr?.token ?? PlaceholderToken,
      errorMessage: `Expected to return a compile-time value, but got runtime value.`,
    });
  }

  // Pop the env frame
  // NOTE: We need to ignore check here because the top frame might contain tempVariable holding the return value.
  //       The check should be handled when evaluating the begin expression.
  env = popEnvFrame(env, true);

  // For closures, consume the captured variables from outer scopes
  let finalCallerEnv = callerEnv;
  if (isInClosureContext && capturedVariables && capturedVariables.size > 0) {
    finalCallerEnv = consumeCapturedVariables({
      capturedVariables,
      env: callerEnv,
      closureToken: expr.token,
    });
  }

  // Reset the cache
  // functionValue.calledComptimeFunctionCaches = [];

  // If we're in CTFE analysis mode OR actually executing a CTFE function
  // (forceCompileTimeBindings is true), also analyze this nested function for CTFE capability.
  // This allows nested functions to be called at compile-time.
  let finalFunctionValue = functionValue;
  let finalFunctionType = newFunctionType;

  if (context.isAnalyzingCtfeCapability || context.forceCompileTimeBindings) {
    const comptimeFunctionValue = analyzeCtfeCapability(
      functionValue,
      finalCallerEnv,
      context
    );
    if (comptimeFunctionValue) {
      // Use the CTFE version so it can be called at compile-time
      finalFunctionValue = comptimeFunctionValue;
      finalFunctionType = comptimeFunctionValue.type;
    }
  }

  // Set the function type and value
  expr.$ = {
    env: finalCallerEnv,
    value: finalFunctionValue,
    type: finalFunctionType,
    pathCollection:
      capturedVariables && capturedVariables.size > 0
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
  };

  return expr;
}
