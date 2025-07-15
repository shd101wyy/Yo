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
  FunctionCapturedVariableInfo,
  FunctionValue,
} from "../../function-value";
import {
  areTypesCompatible,
  ClosureType,
  createClosureType,
  FunctionType,
  isClosureType,
  isFunctionType,
  Type,
  typeToString,
} from "../../types";
import { randomId } from "../../utils";
import { createClosureValue, Value } from "../../value";
import { ValueTag } from "../../value-tag";
import { CapturedVariableInfo, EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
import { evaluateFunctionParameters } from "../types/function";
import {
  buildPathCollectionFromCapturedVariables,
  consumeCapturedVariables,
  createCaptureTypeAndValue,
} from "../utils/closure";

export function evaluateAnonymousFunctionImplementation({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const expectedType = context.expectedType?.type;
  if (!expectedType) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected a function type, got:\n${exprToString(expr)}`,
    });
  }

  // Handle both FunctionType and ClosureType
  let functionType: FunctionType;
  let isCreatingClosure = false;
  let expectedClosureType: ClosureType | undefined;

  if (isFunctionType(expectedType)) {
    functionType = expectedType;
  } else if (isClosureType(expectedType)) {
    // Extract the call type from the closure
    expectedClosureType = expectedType;
    functionType = expectedType.callType;
    isCreatingClosure = true;
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected a function type or closure type, got:\n${typeToString(expectedType)}`,
    });
  }

  // Determine the expected operator based on the closure kind
  let expectedOperator: string;
  let operatorDescription: string;

  if (functionType.closureKind === "FnOnce") {
    expectedOperator = "=>";
    operatorDescription = "FnOnce closure";
  } else if (
    functionType.closureKind === "Fn" ||
    functionType.closureKind === "FnMut"
  ) {
    expectedOperator = "=>>";
    operatorDescription = `${functionType.closureKind} closure`;
  } else {
    // Regular function (not a closure)
    expectedOperator = "->";
    operatorDescription = "function";
  }

  if (!exprIsFunctionCallOf(expr, expectedOperator, 2)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ${expectedOperator} for anonymous ${operatorDescription}, got:\n${exprToString(expr)}`,
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
  const isClosureFunction = functionType.closureKind !== undefined;
  const capturedVariables = isClosureFunction
    ? new Map<string, CapturedVariableInfo>()
    : undefined;
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
  if (isClosureFunction && capturedVariables && capturedVariables.size > 0) {
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

  // For closures, prepare captured variables with values and types for the function value
  let capturedVariablesWithValues:
    | Map<string, FunctionCapturedVariableInfo>
    | undefined;

  if (isClosureFunction && capturedVariables && capturedVariables.size > 0) {
    capturedVariablesWithValues = new Map();
    for (const [varName, captureInfo] of capturedVariables.entries()) {
      // Get the variable value and type from the specific frame level
      if (captureInfo.frameLevel < env.frames.length) {
        const frame = env.frames[captureInfo.frameLevel]!;
        const variable = frame.variables.find((v) => v.name === varName);
        if (variable) {
          capturedVariablesWithValues.set(varName, {
            ...captureInfo,
            value: variable.value, // Can be undefined for runtime values
            type: variable.type,
          });
        }
      }
    }
  }

  // Set the type and value of the expression
  let finalType: Type;
  let finalValue: Value;

  if (isCreatingClosure && expectedClosureType) {
    // Create a closure type and closure value using helper function
    const { captureType, captureValue } = createCaptureTypeAndValue({
      expectedCaptureType: expectedClosureType.captureType,
      capturedVariablesWithValues,
      env,
      closureToken: expr.token,
    });

    const closureType = createClosureType(captureType, newFunctionType, env);

    // Create the function value first
    const functionValue: FunctionValue = {
      tag: ValueTag.Function,
      type: newFunctionType, // The function value uses the call type
      body: functionBodyExpr,
      frameLevel: env.frames.length - 1,
      funcId: `closure_${randomId()}`,
      calledComptFunctionCaches: [],
      specializedFunctionCaches: [],
      SelfType: context.SelfType,
      capturedVariables: capturedVariablesWithValues,
    };

    // Create the closure value
    finalType = closureType;
    finalValue = createClosureValue(
      closureType,
      captureValue, // captureValue is already typed as StructValue | undefined
      functionValue
    );
  } else {
    // Regular function
    finalType = newFunctionType;
    finalValue = {
      tag: ValueTag.Function,
      type: newFunctionType,
      body: functionBodyExpr,
      frameLevel: env.frames.length - 1,
      funcId: `fn_${randomId()}`,
      calledComptFunctionCaches: [],
      specializedFunctionCaches: [],
      SelfType: context.SelfType,
      capturedVariables: capturedVariablesWithValues,
    };
  }

  expr.$ = {
    env,
    type: finalType,
    value: finalValue,
    isMutable: false,
    pathCollection:
      isClosureFunction && capturedVariables
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
  };

  // For closures, attach a temporary variable so they can be consumed
  // This must be done AFTER expr.$ is set since attachTempVariableToExpr expects it
  if (isClosureFunction) {
    attachTempVariableToExpr(expr);
  }

  return expr;
}
