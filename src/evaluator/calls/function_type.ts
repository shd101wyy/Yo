import {
  addVariableToEnv,
  Environment,
  keepTopLevelFrameAndComptimeVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, FuncCallExpr } from "../../expr";
import { FunctionValue } from "../../function-value";
import { PlaceholderToken } from "../../token";
import {
  areTypesCompatible,
  FunctionType,
  isFunctionType,
  typeToString,
} from "../../types";
import { randomId } from "../../utils";
import { createUnknownValue } from "../../value";
import { ValueTag } from "../../value-tag";
import {
  CapturedVariableInfo,
  EvaluatorContext,
  FunctionEvaluationContext,
} from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
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
    capturedVariables, // Set the captured variables map here
    expectedType: {
      type: functionType.return.type,
      env: env,
    },
    functionReturnImplConcreteType: [], // Empty array for each function
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
  expr: FuncCallExpr;
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
          value: createUnknownValue(forallParam.type, forallParam.label),
          token: PlaceholderToken,
          initializedAtToken: PlaceholderToken,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
        skipCheckingFunctionOverloading: true,
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
            ? createUnknownValue(anonymousParam.type, expectedParamName)
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
        skipCheckingFunctionOverloading: true,
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
  // If we did parameter aliasing, we need to update the function type to use
  // the expected parameter names for proper codegen
  const newFunctionType: FunctionType =
    needsParameterAliasing && expectedType && isFunctionType(expectedType)
      ? {
          ...functionType,
          parameters: expectedType.parameters.map((expectedParam, i) => ({
            ...functionType.parameters[i]!,
            label: expectedParam.label, // Use expected name for C codegen
          })),
          parametersFrame,
          env: functionType.env,
        }
      : {
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
    funcId: `fn_${randomId()}`,
    calledComptFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Create a mutable context that we can check after evaluation
  // For regular functions (not closures), we clear capturedVariables to prevent
  // outer variables from being incorrectly marked as captured/consumed.
  const { evaluationContext } = createFunctionBodyEvaluationContext(
    { ...context, capturedVariables: undefined },
    newFunctionType,
    functionValue,
    env
  );

  const evaluatedFunctionBody = evaluateBeginExpression({
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

  // Get captured variables from the evaluation context
  const capturedVariables = evaluationContext.capturedVariables;

  // Check if the function body type matches the function return type
  const functionBodyReturnType = evaluatedFunctionBody.$.type;

  // Regular function: body type must match return type exactly
  if (
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

  if (
    newFunctionType.return.isCompileTimeOnly &&
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
  // functionValue.calledComptFunctionCaches = [];

  // Set the function type and value
  expr.$ = {
    env: finalCallerEnv,
    value: functionValue,
    type: newFunctionType,
    pathCollection:
      capturedVariables && capturedVariables.size > 0
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
  };

  return expr;
}
