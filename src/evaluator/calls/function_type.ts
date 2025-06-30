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
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";

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
    // QUESTION: Allow to keep the comptime variables, but not the runtime ones?
    // We should also keep the very top (the first) frame, including comptime and runtime variables.
    keepTopLevelFrameAndComptimeVariablesFromEnv(callerEnv),
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
  const evaluatedFunctionBody = evaluateBeginExpression({
    expr: functionBodyExpr,
    env,
    context: {
      ...context,
      isEvaluatingFunctionBody: { type: functionType },
      expectedType: {
        type: functionType.return.type,
        env: env, // QUESTION: What should be the env here?
      },
    },
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

  // Set the function type and value
  expr.$ = {
    env: callerEnv,
    value: functionValue,
    type: functionType,
    isMutable: false,
    pathCollection: [],
  };

  return expr;
}
