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
  cloneExpr,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import {
  FunctionCapturedVariableInfo,
  FunctionValue,
} from "../../function-value";
import { PlaceholderToken } from "../../token";
import { areTypesCompatible } from "../../types/compatibility";
import { createFnTraitType } from "../../types/creators";
import {
  FnTraitType,
  FunctionType,
  SomeType,
  StructType,
  Type,
} from "../../types/definitions";
import { isDynType, isFunctionType, isSomeType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import { randomId } from "../../utils";
import { createUnknownValue, Value } from "../../value";
import { ValueTag } from "../../value-tag";
import { createFunctionBodyEvaluationContext } from "../calls/function-type";
import { EvaluatorContext } from "../context";
import { analyzeCtfeCapability } from "../ctfe/ctfe-analysis";
import { evaluateBeginExpression } from "../exprs/begin";
import { extractFnTraitFromType } from "../trait-checking";
import { applyWhereClauseConstraints } from "../types/function";
import {
  buildPathCollectionFromCapturedVariables,
  createCaptureTypeAndValue,
  enrichCapturedVariables,
  generateCapturedVariableDupExpressions,
} from "../utils/closure";

export function evaluateAnonymousFunctionImplementation({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const expectedType = context.expectedType?.type;
  if (!expectedType) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected a function type, got:\n${exprToString(expr)}`,
    });
  }

  // Handle FunctionType and SomeType (from Impl(Fn(...)))
  // Use `dyn (x) => expr` to get Dyn(Fn(...)) for dynamic dispatch
  let functionType: FunctionType;
  let isCreatingClosure = false;
  let expectedFnModuleType: FnTraitType | undefined;
  let wrapperType: SomeType | undefined;

  if (isFunctionType(expectedType)) {
    functionType = expectedType;
  } else if (isSomeType(expectedType)) {
    // Handle Impl(Fn(...)) - SomeType with required modules containing a FnTraitType
    const fnModuleFromWrapper = extractFnTraitFromType(expectedType);
    if (fnModuleFromWrapper) {
      expectedFnModuleType = fnModuleFromWrapper;
      functionType = fnModuleFromWrapper.isFn.callType;
      isCreatingClosure = true;
      wrapperType = expectedType;
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected a function type or Impl(Fn(...)), got:\n${typeToString(expectedType)}`,
      });
    }
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected a function type or Impl(Fn(...)), got:\n${typeToString(expectedType)}${isDynType(expectedType) ? "\nUse 'dyn((x) => expr)' for dynamic dispatch" : ""}`,
    });
  }

  // For closures (from Impl(Fn(...))), we expect the `=>` operator
  // For regular functions, we expect `->`
  const expectedOperator = isCreatingClosure ? "=>" : "->";
  const operatorDescription = isCreatingClosure ? "closure" : "function";

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

  if (regularParamExprs.length !== functionType.parameters.length) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ${functionType.parameters.length} regular parameters, got ${regularParamExprs.length}`,
    });
  }

  const envWithoutParametersFrame = env;
  // Add parameters to environment
  env = pushEnvFrame(env);

  // Validate parameter names for comptime parameters (forall, implicit, and comptime regular parameters)
  // Check forall parameters (always comptime)
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
        isCompileTimeOnly: expectedParam.isCompileTimeOnly,
        value: [
          createUnknownValue(expectedParam.type, {
            variableName: expectedParam.label,
            env,
            context,
          }),
        ],
        token: paramExpr?.token ?? PlaceholderToken,
        initializedAtToken: paramExpr?.token ?? PlaceholderToken,
        consumedAtToken: undefined,
        isOwningTheRcValue: false,
      },
    });
    env = nextEnv;

    if (paramExpr) {
      paramExpr.$ = {
        env: env,
        type: expectedParam.type,
        value: createUnknownValue(expectedParam.type, {
          variableName: expectedParam.label,
          env,
          context,
        }),
        pathCollection: [],
      };
    }
  }

  // Check regular parameters (only comptime ones need exact matching)
  for (let i = 0; i < regularParamExprs.length; i++) {
    const paramExpr = regularParamExprs[i]!;
    const expectedParam = functionType.parameters[i]!;

    if (expectedParam.isCompileTimeOnly) {
      // For comptime parameters, require exact name matching (except for _ which is a wildcard)
      if (!exprIsAtom(paramExpr)) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `Expected parameter name for compile-time parameter, got ${exprToString(paramExpr)}`,
        });
      }

      const paramName = paramExpr.token.value;
      // Allow _ as a wildcard that matches any expected parameter name
      if (paramName !== "_" && paramName !== expectedParam.label) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `Compile-time parameter name must match expected name.
Expected: "${expectedParam.label}"
Got:      "${paramName}"`,
        });
      }
    }

    // Add regular parameter to environment
    // Use the expected parameter's isOwningTheRcValue to properly track ownership
    // (borrowed parameters default to false, owned parameters are true)
    const anonymousParamName = paramExpr.token.value;
    const expectedParamName = expectedParam.label;
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: anonymousParamName,
        type: expectedParam.type,
        isCompileTimeOnly: expectedParam.isCompileTimeOnly,
        value: expectedParam.isCompileTimeOnly
          ? [
              createUnknownValue(expectedParam.type, {
                variableName: expectedParam.label,
                env,
                context,
              }),
            ]
          : undefined,
        token: paramExpr.token,
        initializedAtToken: paramExpr.token,
        consumedAtToken: undefined,
        isOwningTheRcValue: expectedParam.isOwningTheRcValue, // Parameters borrow by default
        // If anonymous function uses different parameter name than expected,
        // store the expected name as alias for C codegen
        parameterAlias:
          anonymousParamName !== expectedParamName
            ? expectedParamName
            : undefined,
      },
    });
    env = nextEnv;

    paramExpr.$ = {
      env: env,
      type: expectedParam.type,
      value: expectedParam.isCompileTimeOnly
        ? createUnknownValue(expectedParam.type, {
            variableName: expectedParam.label,
            env,
            context,
          })
        : undefined,
      pathCollection: [],
    };
  }

  const parametersFrame = env.frames[env.frames.length - 1]!;

  // Create new function type using expected forall/implicit parameters and mixing anonymous + expected regular parameters
  const newFunctionType: FunctionType = {
    ...functionType,
    // forall parameters must use expected names/types entirely (they're always comptime)
    forallParameters: functionType.forallParameters,
    // For regular parameters: use expected types but allow anonymous names for non-comptime parameters
    parameters: functionType.parameters.map((expectedParam, index) => {
      if (expectedParam.isCompileTimeOnly) {
        // Comptime parameters must use expected name and type
        return expectedParam;
      } else {
        // Non-comptime parameters can use anonymous function's name with expected type
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

  // Re-apply where-clause constraints for this function body evaluation.
  if (newFunctionType.whereClauseExprs?.length) {
    const constraintExprs = newFunctionType.whereClauseExprs.map((expr) =>
      cloneExpr(expr)
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

  // Create the function value BEFORE evaluating the function body (fixing FIXME)
  const functionValue: FunctionValue = {
    tag: ValueTag.Function,
    type: newFunctionType,
    body: functionBodyExpr,
    frameLevel: env.frames.length - 1,
    funcId: `fn_${randomId(env.modulePath)}`,
    calledComptimeFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Evaluate the function body
  // A function is a closure if it's being used as an implementation of an Fn trait (FnTraitType)
  const isClosureFunction = !!expectedFnModuleType;

  // Check if the function has forall type parameters
  // If so, we should NOT evaluate the body at definition time because we can't
  // execute code that uses type variables. The body will be evaluated when the
  // function is called with concrete type arguments.
  // const hasForallTypeParams = functionType.forallParameters.length > 0;

  let evaluationContext: EvaluatorContext;
  let evaluatedBody: Expr;

  // if (hasForallTypeParams) {
  //   // Don't evaluate the body for generic functions
  //   // Just attach the environment for later use when called
  //   functionBodyExpr.$ = {
  //     env,
  //     type: functionType.return.type,
  //     value: functionType.return.isCompileTimeOnly
  //       ? createUnknownValue(functionType.return.type, "function_body")
  //       : undefined,
  //     pathCollection: [],
  //   };
  //   // Create a minimal evaluation context for generic functions
  //   evaluationContext = {
  //     ...context,
  //     isExecuting: false,
  //     capturedVariables: new Map(),
  //   };
  //   evaluatedBody = functionBodyExpr;
  // } else
  {
    // Non-generic function: evaluate the body now
    // eslint-disable-next-line prefer-const
    let { evaluationContext: ctx } = createFunctionBodyEvaluationContext(
      {
        ...context,
        isExecuting: false, // We're analyzing, not executing
        isValidatingFunctionDefinition: false, // Clear the validation flag during actual execution
      },
      functionType,
      functionValue,
      env
    );
    evaluationContext = ctx;

    evaluatedBody = evaluateBeginExpression({
      expr: functionBodyExpr,
      env,
      context: evaluationContext,
      variablesToAdd: [],
      isEvaluatingFunctionBodyBeginBlock: true,
    });

    if (!evaluatedBody.$) {
      throw formatErrorMessage({
        token: functionBodyExpr.token,
        errorMessage: `Failed to evaluate the function body.`,
      });
    }
    env = evaluatedBody.$.env;
  }

  // Get captured variables from the evaluation context
  const capturedVariables = evaluationContext.capturedVariables;

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

  // For closures, prepare captured variables with values and types for the function value
  // NOTE: This must happen BEFORE consuming the variables, using the current env
  let capturedVariablesWithValues:
    | Map<string, FunctionCapturedVariableInfo>
    | undefined;

  if (isClosureFunction && capturedVariables && capturedVariables.size > 0) {
    capturedVariablesWithValues = enrichCapturedVariables({
      capturedVariables,
      env,
    });
  }

  // Set the type and value of the expression
  let finalType: Type;
  let finalValue: Value | undefined;
  let capturedVariableDupExpressions: Expr[] | undefined;
  let captureType: StructType | undefined;
  let finalFunctionValue = functionValue;

  // If we're in CTFE analysis mode OR actually executing a CTFE function
  // (forceCompileTimeBindings is true), also analyze this nested function for CTFE capability
  if (
    (context.isAnalyzingCtfeCapability || context.forceCompileTimeBindings) &&
    !isCreatingClosure
  ) {
    const comptimeFunctionValue = analyzeCtfeCapability(
      functionValue,
      env,
      context
    );
    if (comptimeFunctionValue) {
      // Use the CTFE version for nested anonymous functions
      finalFunctionValue = comptimeFunctionValue;
    }
  }

  if (isCreatingClosure && expectedFnModuleType && wrapperType) {
    // Create a closure type and closure value using helper function
    // We don't need the captureValue since closures are runtime-only
    const result = createCaptureTypeAndValue({
      expectedCaptureType: undefined, // Capture type is no longer part of FnTraitType
      capturedVariablesWithValues,
      env,
      closureToken: expr.token,
      context: { ...context },
    });
    captureType = result.captureType;

    const closureType = createFnTraitType(newFunctionType, env);

    // Generate ___dup expressions for captured ARC variables
    // NOTE: This must happen BEFORE consuming the variables
    const { capturedVariableDupExpressions: dupExpressions, env: updatedEnv } =
      generateCapturedVariableDupExpressions({
        capturedVariablesWithValues,
        env,
        context,
      });
    capturedVariableDupExpressions = dupExpressions;
    env = updatedEnv;

    // Update the existing function value for closures
    functionValue.funcId = `closure_${randomId(env.modulePath)}`;

    // Set the closure info for easy codegen access
    functionValue.closureInfo = {
      closureType: closureType,
      captureType: captureType,
    };

    // IMPORTANT: Mutate the wrapper SomeType in-place so downstream generic specialization
    // (e.g. `box`) can observe the concrete capture struct and codegen can use it.
    // We also return a resolved copy for local typing, but the in-place update is the key.
    wrapperType.resolvedConcreteType = captureType;
    finalType = {
      ...wrapperType,
      resolvedConcreteType: captureType,
    } as SomeType;

    // Closures are always runtime values - create an UnknownValue
    // The closure will be constructed at runtime in C code
    finalValue = undefined;
  } else {
    // Regular function - use the final function value (CTFE version if available)
    finalType = finalFunctionValue.type;
    finalValue = finalFunctionValue;
  }

  expr.$ = {
    env,
    type: finalType,
    value: finalValue,
    pathCollection:
      isClosureFunction && capturedVariables
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
    deferredDupExpressions:
      isCreatingClosure && capturedVariableDupExpressions
        ? capturedVariableDupExpressions
        : undefined,
    captureType: isCreatingClosure ? captureType : undefined, // Store the capture struct type for codegen (used for both closures and async blocks)
    closureFunctionValue: isCreatingClosure ? finalFunctionValue : undefined,
  };

  // For closures, attach a temporary variable so they can be consumed
  // This must be done AFTER expr.$ is set since attachTempVariableToExpr expects it
  if (isClosureFunction) {
    attachTempVariableToExpr(expr, true);
  }

  return expr;
}
