import {
  addVariableToEnv,
  Environment,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  FunctionCapturedVariableInfo,
  FunctionValue,
} from "../../function-value";
import { PlaceholderToken } from "../../token";
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
import { createClosureValue, createUnknownValue, Value } from "../../value";
import { ValueTag } from "../../value-tag";
import { createFunctionBodyEvaluationContext } from "../calls/function_type";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
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

  // NOTE: Don't cloneExpr here. It will affect the vscode extension.
  const functionBodyExpr = expr.args[1]!;

  let parameterExprs: Expr[] = [];
  if (
    exprIsFunctionCall(functionDeclarationExpr) &&
    exprIsFunctionCallOf(functionDeclarationExpr, BuiltinKeywords.tuple)
  ) {
    parameterExprs = functionDeclarationExpr.args;
  } else {
    parameterExprs = [functionDeclarationExpr];
  }

  // Parse parameter expressions to separate forall, using, and regular parameters
  let forallParamExprs: Expr[] = [];
  let implicitParamExprs: Expr[] = [];
  const regularParamExprs: Expr[] = [];

  for (let i = 0; i < parameterExprs.length; i++) {
    const paramExpr = parameterExprs[i]!;

    if (
      exprIsFunctionCall(paramExpr) &&
      exprIsFunctionCallOf(paramExpr, BuiltinKeywords.forall)
    ) {
      if (i !== 0) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `forall(...) must be the first parameter expression`,
        });
      }
      forallParamExprs = paramExpr.args;
    } else if (
      exprIsFunctionCall(paramExpr) &&
      exprIsFunctionCallOf(paramExpr, BuiltinKeywords.using)
    ) {
      if (i !== parameterExprs.length - 1) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `using(...) must be the last parameter expression`,
        });
      }
      implicitParamExprs = paramExpr.args;
    } else {
      regularParamExprs.push(paramExpr);
    }
  }

  // Validate parameter counts match expected function type
  /*
  if (forallParamExprs.length !== functionType.forallParameters.length) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ${functionType.forallParameters.length} forall parameters, got ${forallParamExprs.length}`,
    });
  }
  */

  /*
  if (implicitParamExprs.length !== functionType.implicitParameters.length) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ${functionType.implicitParameters.length} implicit parameters, got ${implicitParamExprs.length}`,
    });
  }
  */

  if (regularParamExprs.length !== functionType.parameters.length) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ${functionType.parameters.length} regular parameters, got ${regularParamExprs.length}`,
    });
  }

  const envWithoutParametersFrame = env;
  // Add parameters to environment
  env = pushEnvFrame(env);

  // Validate parameter names for compt parameters (forall, implicit, and compt regular parameters)
  // Check forall parameters (always compt)
  for (let i = 0; i < forallParamExprs.length; i++) {
    const paramExpr = forallParamExprs[i]!;
    const expectedParam = functionType.forallParameters[i]!;

    if (!exprIsAtom(paramExpr)) {
      throw formatErrorMessage({
        token: paramExpr.token,
        errorMessage: `Expected parameter name for forall parameter, got ${exprToString(paramExpr)}`,
      });
    }

    const paramName = paramExpr.token.value;
    if (paramName !== expectedParam.label) {
      throw formatErrorMessage({
        token: paramExpr.token,
        errorMessage: `Forall parameter name must match expected name.
Expected: "${expectedParam.label}"
Got:      "${paramName}"`,
      });
    }
  }
  for (let i = 0; i < functionType.forallParameters.length; i++) {
    const paramExpr = forallParamExprs[i];
    const expectedParam = functionType.forallParameters[i]!;
    // Add forall parameter to environment
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: expectedParam.label,
        type: expectedParam.type,
        isMutable: expectedParam.isMutable,
        isCompileTimeOnly: expectedParam.isCompileTimeOnly,
        isImplicit: false,
        value: createUnknownValue(expectedParam.type, expectedParam.label),
        token: paramExpr?.token ?? PlaceholderToken,
        initializedAtToken: paramExpr?.token ?? PlaceholderToken,
        consumedAtToken: undefined,
      },
      skipCheckingFunctionOverloading: true,
    });
    env = nextEnv;

    if (paramExpr) {
      paramExpr.$ = {
        env: env,
        type: expectedParam.type,
        value: createUnknownValue(expectedParam.type, expectedParam.label),
        isMutable: expectedParam.isMutable,
        pathCollection: [],
      };
    }
  }

  // Check regular parameters (only compt ones need exact matching)
  for (let i = 0; i < regularParamExprs.length; i++) {
    const paramExpr = regularParamExprs[i]!;
    const expectedParam = functionType.parameters[i]!;

    if (expectedParam.isCompileTimeOnly) {
      // For compt parameters, require exact name matching
      if (!exprIsAtom(paramExpr)) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `Expected parameter name for compile-time parameter, got ${exprToString(paramExpr)}`,
        });
      }

      const paramName = paramExpr.token.value;
      if (paramName !== expectedParam.label) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `Compile-time parameter name must match expected name.
Expected: "${expectedParam.label}"
Got:      "${paramName}"`,
        });
      }
    }

    // Add regular parameter to environment
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: paramExpr.token.value,
        type: expectedParam.type,
        isMutable: expectedParam.isMutable,
        isCompileTimeOnly: expectedParam.isCompileTimeOnly,
        isImplicit: false,
        value: expectedParam.isCompileTimeOnly
          ? createUnknownValue(expectedParam.type, expectedParam.label)
          : undefined,
        token: paramExpr.token,
        initializedAtToken: paramExpr.token,
        consumedAtToken: undefined,
      },
      skipCheckingFunctionOverloading: true,
    });
    env = nextEnv;

    paramExpr.$ = {
      env: env,
      type: expectedParam.type,
      value: expectedParam.isCompileTimeOnly
        ? createUnknownValue(expectedParam.type, expectedParam.label)
        : undefined,
      isMutable: expectedParam.isMutable,
      pathCollection: [],
    };
  }

  // Check implicit parameters (always compt)
  for (let i = 0; i < implicitParamExprs.length; i++) {
    const paramExpr = implicitParamExprs[i]!;
    const expectedParam = functionType.implicitParameters[i]!;

    if (!exprIsAtom(paramExpr)) {
      throw formatErrorMessage({
        token: paramExpr.token,
        errorMessage: `Expected parameter name for implicit parameter, got ${exprToString(paramExpr)}`,
      });
    }

    const paramName = paramExpr.token.value;
    if (paramName !== expectedParam.label) {
      throw formatErrorMessage({
        token: paramExpr.token,
        errorMessage: `Implicit parameter name must match expected name.
Expected: "${expectedParam.label}"
Got:      "${paramName}"`,
      });
    }
  }
  for (let i = 0; i < functionType.implicitParameters.length; i++) {
    const paramExpr = implicitParamExprs[i];
    const expectedParam = functionType.implicitParameters[i]!;
    // Add implicit parameter to environment
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: expectedParam.label,
        type: expectedParam.type,
        isMutable: expectedParam.isMutable,
        isCompileTimeOnly: expectedParam.isCompileTimeOnly,
        isImplicit: true,
        value: createUnknownValue(expectedParam.type, expectedParam.label),
        token: paramExpr?.token ?? PlaceholderToken,
        initializedAtToken: paramExpr?.token ?? PlaceholderToken,
        consumedAtToken: undefined,
      },
      skipCheckingFunctionOverloading: true,
    });
    env = nextEnv;

    if (paramExpr) {
      paramExpr.$ = {
        env: env,
        type: expectedParam.type,
        value: createUnknownValue(expectedParam.type, expectedParam.label),
        isMutable: expectedParam.isMutable,
        pathCollection: [],
      };
    }
  }

  const parametersFrame = env.frames[env.frames.length - 1]!;

  // Create new function type using expected forall/implicit parameters and mixing anonymous + expected regular parameters
  const newFunctionType: FunctionType = {
    ...functionType,
    // forall and implicit parameters must use expected names/types entirely (they're always compt)
    forallParameters: functionType.forallParameters,
    implicitParameters: functionType.implicitParameters,
    // For regular parameters: use expected types but allow anonymous names for non-compt parameters
    parameters: functionType.parameters.map((expectedParam, index) => {
      if (expectedParam.isCompileTimeOnly) {
        // Compt parameters must use expected name and type
        return expectedParam;
      } else {
        // Non-compt parameters can use anonymous function's name with expected type
        const paramExpr = regularParamExprs[index]!;
        return {
          ...expectedParam,
          label: exprIsAtom(paramExpr)
            ? paramExpr.token.value
            : expectedParam.label,
          exprs: {
            ...expectedParam.exprs,
            expr: paramExpr,
            labelExpr: paramExpr,
            typeExpr: undefined, // Clear typeExpr for anonymous functions
            defaultValueExpr: undefined, // Anonymous functions can't have default values
          },
        };
      }
    }),
    return: {
      ...functionType.return,
      expr: undefined, // Clear return expr for anonymous functions
    },
    parametersFrame: parametersFrame,
    env: envWithoutParametersFrame, // functionType.env, // Here we need to use the functionType.env, not the current env for later CPS transformation use.
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
