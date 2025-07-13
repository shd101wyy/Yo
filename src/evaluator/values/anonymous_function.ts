import { Environment, popEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  FunctionType,
  isFunctionType,
  typeToString,
} from "../../types";
import { randomId } from "../../utils";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
import { evaluateFunctionParameters } from "../types/function";
import { consumeCapturedVariables } from "../utils/closure";

export function evaluateAnonymousFunctionImplementation({
  expr,
  env,
  context,
  isClosure,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
  isClosure?: boolean;
}): FuncCallExpr {
  const functionType = context.expectedType?.type;
  if (!functionType) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected a function type, got:\n${exprToString(expr)}`,
    });
  }
  if (!isFunctionType(functionType)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected a function type, got:\n${typeToString(functionType)}`,
    });
  }

  const expectedOperator = isClosure ? "=>" : "->";
  if (!exprIsFunctionCallOf(expr, expectedOperator, 2)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ${expectedOperator} for anonymous ${isClosure ? "closure" : "function"}, got:\n${exprToString(expr)}`,
    });
  }
  const functionDeclarationExpr = expr.args[0]!;
  const functionBodyExpr = expr.args[1]!;

  if (
    !exprIsFunctionCall(functionDeclarationExpr) ||
    !exprIsFunctionCallOf(functionDeclarationExpr, BuiltinKeywords.fn)
  ) {
    throw formatErrorMessage({
      token: functionDeclarationExpr.token,
      errorMessage: `Expected "fn" for anonymous function, got:\n${exprToString(
        functionDeclarationExpr
      )}`,
    });
  }

  // NOTE: We disallow to define function signature for anonymous function anymore.
  // Evaluate the parameter list
  // env = pushEnvFrame(env); // < this is done in evaluateFunctionParameters function.
  const {
    env: nextEnv,
    typeParameters,
    parameters,
    implicitParameters,
  } = evaluateFunctionParameters({
    parameterExprs: functionDeclarationExpr.args,
    expectedFunctionType: functionType,
    env,
    context: {
      ...context,
    },
  });
  env = nextEnv;

  // Evaluate the function body
  const capturedVariables = isClosure ? new Map<string, number>() : undefined;
  const evaluatedBody = evaluateBeginExpression({
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
        env: env,
      },
    },
    variablesToAdd: [],
  });

  // Check if the return type is compatible
  const evaluatedBodyReturnType = evaluatedBody.$?.type;
  if (
    evaluatedBodyReturnType &&
    !areTypesCompatible(
      { type: functionType.return.type, env },
      { type: evaluatedBodyReturnType, env }
    )
  ) {
    throw formatErrorMessage({
      token: functionBodyExpr.token,
      errorMessage: `Incompatible return type:
- Expected: ${typeToString(functionType.return.type)}
- Got     : ${typeToString(evaluatedBodyReturnType)}`,
    });
  }

  if (evaluatedBody.$?.env) {
    env = evaluatedBody.$?.env;
  }
  // Restore the env frame
  env = popEnvFrame(env);

  // For closures, consume the captured variables from outer scopes
  if (isClosure && capturedVariables && capturedVariables.size > 0) {
    env = consumeCapturedVariables({
      capturedVariables,
      env,
      closureToken: expr.token,
    });
  }

  // For anonymous functions, we need to use the original function type
  // but with the parameter names from the anonymous function implementation.
  // However, we need to be careful about the parameter expressions structure.
  const newFunctionType: FunctionType = {
    ...functionType,
    typeParameters: typeParameters.map((param, index) => ({
      ...param,
      // For anonymous functions, the type should come from the original function type
      // and the typeExpr should be undefined because we're not defining the type explicitly
      type: functionType.typeParameters[index]?.type ?? param.type,
      exprs: {
        ...param.exprs,
        typeExpr: undefined, // Clear the typeExpr for anonymous functions
      },
    })),
    parameters: parameters.map((param, index) => ({
      ...param,
      // For anonymous functions, the type should come from the original function type
      // and the typeExpr should be undefined because we're not defining the type explicitly
      type: functionType.parameters[index]?.type ?? param.type,
      exprs: {
        ...param.exprs,
        typeExpr: undefined, // Clear the typeExpr for anonymous functions
      },
    })),
    implicitParameters: implicitParameters.map((param, index) => ({
      ...param,
      type: functionType.implicitParameters[index]?.type ?? param.type,
      exprs: {
        ...param.exprs,
        typeExpr: undefined, // Clear the typeExpr for anonymous functions
      },
    })),
  };

  // Set the type and value of the expression
  expr.$ = {
    env,
    type: newFunctionType,
    value: {
      tag: ValueTag.Function,
      type: newFunctionType,
      body: functionBodyExpr,
      frameLevel: env.frames.length - 1,
      funcId: `fn_${randomId()}`,
      calledComptFunctionCaches: [],
      specializedFunctionCaches: [],
      SelfType: context.SelfType,
    },
    isMutable: false,
    pathCollection: [],
  };

  // For closures, attach a temporary variable so they can be consumed
  // This must be done AFTER expr.$ is set since attachTempVariableToExpr expects it
  if (isClosure) {
    attachTempVariableToExpr(expr);
  }

  return expr;
}
