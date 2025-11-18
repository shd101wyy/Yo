import {
  Environment,
  keepTopLevelFrameAndComptimeVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, FuncCallExpr } from "../../expr";
import { FunctionValue } from "../../function-value";
import { PlaceholderToken } from "../../token";
import { areTypesCompatible, FunctionType, typeToString } from "../../types";
import { randomId } from "../../utils";
import { ValueTag } from "../../value-tag";
import {
  CapturedVariableInfo,
  EvaluatorContext,
  FunctionEvaluationContext,
} from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
import { buildPathCollectionFromCapturedVariables } from "../utils/closure";

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

  // Create captured variables map if this is a closure
  const capturedVariables = functionType.isClosure
    ? new Map<string, CapturedVariableInfo>()
    : undefined;

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
  };

  return { evaluationContext, functionBodyContext };
}

/**
 * expr should be the:
 * functionType(functionBody);
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
  let env = pushEnvFrame(
    // For closures, we keep the full caller environment to enable variable capturing
    // For regular functions, we only keep top-level frame and compile-time variables
    functionType.isClosure
      ? callerEnv
      : keepTopLevelFrameAndComptimeVariablesFromEnv(callerEnv),
    functionType.parametersFrame
  );
  // const originalEnv = env; // backup the env for later CPS transformation use.

  // Create the function value
  const functionValue: FunctionValue = {
    tag: ValueTag.Function,
    type: functionType,
    body: functionBodyExpr, // Use transformed body
    frameLevel: env.frames.length - 1,
    funcName: undefined,
    funcId: `fn_${randomId()}`,
    calledComptFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Create a mutable context that we can check after evaluation
  const { evaluationContext } = createFunctionBodyEvaluationContext(
    context,
    functionType,
    functionValue,
    env
  );

  const evaluatedFunctionBody = evaluateBeginExpression({
    expr: functionBodyExpr, // Use transformed body
    env,
    context: evaluationContext,
    variablesToAdd: [],
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
      { type: functionType.return.type, env },
      { type: functionBodyReturnType, env }
    )
  ) {
    // console.trace();
    throw formatErrorMessage({
      token: functionType.return.expr?.token ?? PlaceholderToken,
      errorMessage: `Incompatible function return type for:
- Expected: ${typeToString(functionType.return.type)}
- Given  : ${typeToString(functionBodyReturnType)}`,
    });
  }

  if (functionType.return.isCompileTimeOnly && !evaluatedFunctionBody.$.value) {
    throw formatErrorMessage({
      token: functionType.return.expr?.token ?? PlaceholderToken,
      errorMessage: `Expected to return a compile-time value, but got runtime value.`,
    });
  }

  // Pop the env frame
  // NOTE: We need to ignore check here because the top frame might contain tempVariable holding the return value.
  //       The check should be handled when evaluating the begin expression.
  env = popEnvFrame(env, true);

  // ~~For closures, consume the captured variables from outer scopes~~
  const finalCallerEnv = callerEnv;

  // Reset the cache
  // functionValue.calledComptFunctionCaches = [];

  // Set the function type and value
  expr.$ = {
    env: finalCallerEnv,
    value: functionValue,
    type: functionType,
    pathCollection:
      capturedVariables && capturedVariables.size > 0
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
  };

  return expr;
}
