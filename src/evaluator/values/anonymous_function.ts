import { transformFunctionBodyToCps } from "../../cps-transform";
import { Environment, popEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  cloneExpr,
  Expr,
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
  createEffectHandlerType,
  FunctionType,
  isClosureType,
  isEffectFunctionType,
  isFunctionType,
  Type,
  typeToString,
} from "../../types";
import { randomId } from "../../utils";
import { createClosureValue, Value } from "../../value";
import { ValueTag } from "../../value-tag";
import { createFunctionBodyEvaluationContext } from "../calls/function_type";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
import { evaluateFunctionParameters } from "../types/function";
import {
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
      env
    );
  }

  // Determine the expected operator based on the closure kind
  let expectedOperator: string;
  let operatorDescription: string;

  if (functionType.closureKind === "FnMove") {
    expectedOperator = "=>";
    operatorDescription = "FnMove closure";
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
  const functionBodyExpr = cloneExpr(expr.args[1]!);

  let parameterExprs: Expr[] = [];
  if (
    exprIsFunctionCall(functionDeclarationExpr) &&
    exprIsFunctionCallOf(functionDeclarationExpr, BuiltinKeywords.tuple)
  ) {
    parameterExprs = functionDeclarationExpr.args;
  } else {
    parameterExprs = [functionDeclarationExpr];
  }

  // NOTE: We disallow to define function signature for anonymous function anymore.
  // Evaluate the parameter list
  // env = pushEnvFrame(env); // < this is done in evaluateFunctionParameters function.
  const {
    env: nextEnv,
    forallParameters,
    parameters,
    implicitParameters,
  } = evaluateFunctionParameters({
    parameterExprs: parameterExprs,
    expectedFunctionType: functionType,
    env,
    context: {
      ...context,
    },
  });
  env = nextEnv;
  const originalEnv = env; // backup the env for later CPS transformation use.

  // For anonymous functions, we need to use the original function type
  // but with the parameter names from the anonymous function implementation.
  // However, we need to be careful about the parameter expressions structure.
  const newFunctionType: FunctionType = {
    ...functionType,
    forallParameters: forallParameters.map((param, index) => ({
      ...param,
      // For anonymous functions, the type should come from the original function type
      // and the typeExpr should be undefined because we're not defining the type explicitly
      type: functionType.forallParameters[index]?.type ?? param.type,
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

  // Create the function value BEFORE evaluating the function body (fixing FIXME)
  const functionValue: FunctionValue = {
    tag: ValueTag.Function,
    type: newFunctionType,
    body: functionBodyExpr,
    frameLevel: env.frames.length - 1,
    funcId: `fn_${randomId()}`,
    calledComptFunctionCaches: [],
    specializedFunctionCaches: [],
    SelfType: context.SelfType,
  };

  // Evaluate the function body
  const isClosureFunction = functionType.closureKind !== undefined;
  // eslint-disable-next-line prefer-const
  let { evaluationContext, capturedVariables } =
    createFunctionBodyEvaluationContext(
      {
        ...context,
        isExecuting: false, // We're analyzing, not executing
        isValidatingFunctionDefinition: false, // Clear the validation flag during actual execution
      },
      functionType,
      functionValue,
      env
    );

  const evaluatedBody = evaluateBeginExpression({
    expr: functionBodyExpr,
    env,
    context: evaluationContext,
    variablesToAdd: [],
  });

  if (!evaluatedBody.$) {
    throw formatErrorMessage({
      token: functionBodyExpr.token,
      errorMessage: `Failed to evaluate the function body.`,
    });
  }
  env = evaluatedBody.$.env;

  // Check if the function uses `do` and apply CPS transformation
  if (
    evaluationContext.isEvaluatingFunctionBody?.usedDo &&
    evaluationContext.isEvaluatingFunctionBody?.usedDo.length > 0
  ) {
    console.log(`Function uses 'do', applying CPS transformation...`);

    // Apply CPS transformation to the function body
    const transformedBody = transformFunctionBodyToCps(
      functionBodyExpr,
      functionValue.funcId
    );

    // Store the transformed body separately
    functionValue.cpsTransformedBody = transformedBody;

    const {
      evaluationContext: freshEvaluationContext,
      capturedVariables: freshCapturedVariables,
    } = createFunctionBodyEvaluationContext(
      {
        ...context,
        isExecuting: false,
        isValidatingFunctionDefinition: false,
      },
      functionType,
      functionValue,
      originalEnv
    );
    capturedVariables = freshCapturedVariables;

    // Re-evaluate the transformed body to ensure it's valid
    const evaluatedTransformedBody = evaluateBeginExpression({
      expr: transformedBody,
      env: originalEnv,
      context: freshEvaluationContext,
      variablesToAdd: [],
    });

    if (!evaluatedTransformedBody.$) {
      throw formatErrorMessage({
        token: functionBodyExpr.token,
        errorMessage: `Failed to evaluate the CPS-transformed function body.`,
      });
    }

    console.log(
      `CPS transformation applied to function ${functionValue.funcId}`
    );

    env = evaluatedTransformedBody.$.env;
  }

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
  env = popEnvFrame(env, true);

  // For closures, consume the captured variables from outer scopes
  if (isClosureFunction && capturedVariables && capturedVariables.size > 0) {
    env = consumeCapturedVariables({
      capturedVariables,
      env,
      closureToken: expr.token,
    });
  }

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

  // Update the function value with captured variables (if any)
  if (capturedVariables && capturedVariables.size > 0) {
    functionValue.capturedVariables = new Map();
    for (const [name, info] of capturedVariables) {
      if (info.frameLevel < env.frames.length) {
        const variable = env.frames[info.frameLevel]?.variables.find(
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

    const closureType = createClosureType(newFunctionType, captureType, env);

    // Update the existing function value for closures
    functionValue.funcId = `closure_${randomId()}`;
    functionValue.capturedVariables = capturedVariablesWithValues;

    // Create the closure value
    finalType = closureType;
    finalValue = createClosureValue(
      closureType,
      captureValue, // captureValue is already typed as StructValue | undefined
      functionValue
    );
  } else {
    // Regular function - use the existing functionValue
    finalType = newFunctionType;
    finalValue = functionValue;
  }

  expr.$ = {
    env,
    type: finalType,
    value: finalValue,
    isMutable: false,
  };

  // For closures, attach a temporary variable so they can be consumed
  // This must be done AFTER expr.$ is set since attachTempVariableToExpr expects it
  if (isClosureFunction) {
    attachTempVariableToExpr(expr);
  }

  return expr;
}
