import {
  Environment,
  keepTopLevelFrameAndComptimeVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, FuncCallExpr } from "../../expr";
import { FunctionValue } from "../../function-value";
import { areTypesCompatible, FunctionType, typeToString } from "../../types";
import { randomId } from "../../utils";
import { ValueTag } from "../../value-tag";
import { CapturedVariableInfo, EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
import { consumeCapturedVariables } from "../utils/closure";

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

  // Create the function value
  const functionValue: FunctionValue = {
    tag: ValueTag.Function,
    type: functionType,
    body: functionBodyExpr,
    frameLevel: env.frames.length - 1,
    funcName: undefined,
    funcId: `fn_${randomId()}`,
    calledComptFunctionCaches: [],
    specializedFunctionCaches: [],
    SelfType: context.SelfType, // In theory, this should be undefined.
  };

  // Evaluate the function body
  const capturedVariables =
    functionType.closureKind !== undefined
      ? new Map<string, CapturedVariableInfo>()
      : undefined;
  const evaluatedFunctionBody = evaluateBeginExpression({
    expr: functionBodyExpr,
    env,
    context: {
      ...context,
      isEvaluatingFunctionBody: {
        type: functionType,
        capturedVariables: capturedVariables,
        evaluationEnv: env, // Pass the current evaluation environment
      },
      expectedType: {
        type: functionType.return.type,
        env: env, // QUESTION: What should be the env here?
      },
    },
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
  env = popEnvFrame(env);

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

  // Set the function type and value
  expr.$ = {
    env: finalCallerEnv,
    value: functionValue,
    type: functionType,
    isMutable: false,
    pathCollection: [],
  };

  return expr;
}
