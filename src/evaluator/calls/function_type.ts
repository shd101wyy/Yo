import {
  Environment,
  keepTopLevelFrameAndComptimeVariablesFromEnv,
  popEnvFrame,
  printEnvVarNames,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, FuncCallExpr } from "../../expr";
import { FunctionValue } from "../../function-value";
import {
  areTypesCompatible,
  createEffectHandlerType,
  FunctionType,
  isEffectFunctionType,
  typeToString,
} from "../../types";
import { randomId } from "../../utils";
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
  capturedVariables: Map<string, CapturedVariableInfo> | undefined;
} {
  const { functionBodyContext, capturedVariables } =
    createFreshFunctionBodyContext(functionType, functionValue, env);

  const evaluationContext: EvaluatorContext = {
    ...context,
    isExecuting: false, // We're analyzing, not executing
    isValidatingFunctionDefinition: true, // We're validating function definition
    isEvaluatingFunctionBody: functionBodyContext,
    expectedType: {
      type: functionType.return.type,
      env: env,
    },
  };

  return { evaluationContext, functionBodyContext, capturedVariables };
}

/**
 * Creates a fresh function body context for evaluation
 */
function createFreshFunctionBodyContext(
  functionType: FunctionType,
  functionValue: FunctionValue,
  env: Environment
): {
  functionBodyContext: FunctionEvaluationContext;
  capturedVariables: Map<string, CapturedVariableInfo> | undefined;
} {
  const capturedVariables =
    functionType.closureKind !== undefined
      ? new Map<string, CapturedVariableInfo>()
      : undefined;

  const functionBodyContext: FunctionEvaluationContext = {
    type: functionType,
    value: functionValue,
    capturedVariables: capturedVariables,
    evaluationEnv: env,
    usedDo: undefined, // Initialize usedDo property
  };

  return { functionBodyContext, capturedVariables };
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
  // Check if it's effect handler
  if (isEffectFunctionType(functionType)) {
    // convert it to a handler function
    if (!context.isEvaluatingFunctionBody) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Effect handler can only be defined inside a function body.`,
      });
    }
    const effectFunctionType = functionType;
    const parentFunctionType = context.isEvaluatingFunctionBody.type;
    functionType = createEffectHandlerType(
      effectFunctionType,
      parentFunctionType,
      callerEnv
    );
  }

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
    functionType.closureKind !== undefined
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
    SelfType: context.SelfType, // In theory, this should be undefined.
  };

  // Create a mutable context that we can check after evaluation
  // eslint-disable-next-line prefer-const
  let { evaluationContext, capturedVariables } =
    createFunctionBodyEvaluationContext(
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

  // Check if the function body type matches the function return type
  const functionBodyReturnType = evaluatedFunctionBody.$.type;
  if (
    !areTypesCompatible(
      { type: functionType.return.type, env },
      { type: functionBodyReturnType, env }
    )
  ) {
    printEnvVarNames(env);
    // console.trace();
    // printEnvVarNames(env);
    throw formatErrorMessage({
      token: functionType.return.expr.token,
      errorMessage: `Incompatible function return type:
- Expected: ${typeToString(functionType.return.type)}
- Given  : ${typeToString(functionBodyReturnType)}`,
    });
  }
  if (functionType.return.isCompileTimeOnly && !evaluatedFunctionBody.$.value) {
    throw formatErrorMessage({
      token: functionType.return.expr.token,
      errorMessage: `Expected to return a compile-time value, but got runtime value.`,
    });
  }

  // Pop the env frame
  // NOTE: We need to ignore check here because the top frame might contain tempVariable holding the return value.
  //       The check should be handled when evaluating the begin expression.
  env = popEnvFrame(env, true);

  // For closures, consume the captured variables from outer scopes
  let finalCallerEnv = callerEnv;
  if (
    functionType.closureKind !== undefined &&
    capturedVariables &&
    capturedVariables.size > 0
  ) {
    finalCallerEnv = consumeCapturedVariables({
      capturedVariables,
      env: callerEnv,
      closureToken: expr.token,
    });
  }

  // Update the function value with captured variables (if any)
  if (capturedVariables && capturedVariables.size > 0) {
    functionValue.capturedVariables = new Map();
    for (const [name, info] of capturedVariables) {
      if (info.frameLevel < finalCallerEnv.frames.length) {
        const variable = finalCallerEnv.frames[info.frameLevel]?.variables.find(
          (v) => v.name === name
        );
        if (variable) {
          functionValue.capturedVariables.set(name, {
            ...info,
            value: variable.value,
            type: variable.type,
          });
        }
      }
    }
  }

  // Reset the cache
  // functionValue.calledComptFunctionCaches = [];

  // Set the function type and value
  expr.$ = {
    env: finalCallerEnv,
    value: functionValue,
    type: functionType,
    isMutable: false,
    pathCollection:
      capturedVariables && capturedVariables.size > 0
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
  };

  return expr;
}
