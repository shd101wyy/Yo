import { sanitizeForCIdentifier } from "../../codegen/utils";
import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  getVariablesFromEnvByFilter,
  getVariablesNeedingDrop,
  pushEnvFrame,
  updateExistingVariable,
  Variable,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  cloneExpr,
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
  PathCollection,
  setExprAsNeedsToCallDup,
} from "../../expr";
import { FunctionValue, SpecializedFunctionCache } from "../../function-value";
import { generateExprFromCode } from "../../parser";
import { PlaceholderToken, TokenType } from "../../token";
import {
  areTypesCompatible,
  convertComptTypeToRuntimeType,
  createExprType,
  createFunctionType,
  createSomeType,
  FunctionParameter,
  FunctionType,
  getAllSomeTypes,
  getValueOfSomeTypeFromEnv,
  isClosureType,
  isEnumType,
  isExprListType,
  isExprType,
  isFunctionSpecializable,
  isFunctionType,
  isFutureType,
  isModuleType,
  isStructType,
  isTypeHierarchyType,
  isUnionType,
  Type,
  TypeHierarchyType,
  typeRequiresComptModifier,
  typeToString,
} from "../../types";
import {
  areValuesEqual,
  createExprListValue,
  createExprValue,
  createTypeValue,
  createUnknownValue,
  ExprValue,
  isFunctionValue,
  isModuleValue,
  isTypeValue,
  Value,
  valueToString,
} from "../../value";
import {
  ArgValues,
  CapturedVariableInfo,
  EvaluatorContext,
  FunctionCallResult,
} from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
import {
  evaluateFunctionParameterTypeAgain,
  evaluateFunctionReturnTypeAgain,
} from "../types/function";
import { synthesizeTypes } from "../types/synthesizer";
import { evaluateComptFunctionCall } from "./compt_function";

/**
 * Generate ___drop expressions for variables that need cleanup during function calls.
 *
 * This function creates and evaluates ___drop expressions for variables that require
 * cleanup when a function call completes. These expressions are deferred to the codegen phase
 * to prevent use-after-free errors that would occur if drop calls were inserted
 * directly into the AST during evaluation.
 *
 * @param variablesToDrop - Array of variables that need drop calls
 * @param env - The environment to use for evaluation
 * @param context - The evaluator context
 * @returns Object containing the generated drop expressions and updated environment
 */
function generateDeferredDropExpressions({
  variablesToDrop,
  env,
  context,
}: {
  variablesToDrop: Variable[];
  env: Environment;
  context: EvaluatorContext;
}): {
  deferredDropExpressions: Expr[] | undefined;
  env: Environment;
} {
  const deferredDropExpressions: Expr[] = [];
  let finalEnv = env;

  for (const variable of variablesToDrop) {
    // Create a drop expression: ___drop(varName)
    const dropExpr: Expr = generateExprFromCode(
      `${BuiltinFunctions.___drop[0]!}(${variable.name})`
    );

    // Evaluate the dropExpr to ensure it's properly typed and processed
    const evaluatedDropExpr = context.evaluateExpression({
      expr: dropExpr,
      env: finalEnv,
      context: { ...context },
    });

    deferredDropExpressions.push(evaluatedDropExpr);

    // Update the environment with the evaluated expression's environment
    if (evaluatedDropExpr.$ && evaluatedDropExpr.$.env) {
      finalEnv = evaluatedDropExpr.$.env;
    }
  }

  return {
    deferredDropExpressions:
      deferredDropExpressions.length > 0 ? deferredDropExpressions : undefined,
    env: finalEnv,
  };
}

export function checkIfFunctionParameterMatchesArgument({
  functionType,
  parameter,
  argExprs,
  argIndex,
  calleeEnv,
  callerEnv,
  context,
  isMethodCall,
  runtimeArgExprsInOrder,
}: {
  functionType: FunctionType;
  /**
   * It could be forallParameters, parameters, or implicitParameters
   */
  parameter: FunctionParameter;
  argExprs: Expr[];
  argIndex: number;
  calleeEnv: Environment;
  callerEnv: Environment;
  context: EvaluatorContext;
  isMethodCall: boolean;
  runtimeArgExprsInOrder: Expr[];
}): {
  calleeEnv: Environment;
  callerEnv: Environment;
  context: EvaluatorContext;
  argValue: Value | undefined;
  argType: Type;
  parameterType: Type;
} {
  let argExpr: Expr | undefined = argExprs[argIndex];

  // NOTE: We don't support named argument.
  // But we support to use label for readibility.
  // eg: add(1, 2) vs add(x: 1, y: 2)
  let labelExpr: Expr | undefined = undefined;
  if (
    argExpr &&
    exprIsFunctionCall(argExpr) &&
    exprIsFunctionCallOf(argExpr, ":", 2)
  ) {
    labelExpr = argExpr.args[0]!;
    argExpr = argExpr.args[1]!;

    if (!exprIsAtom(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for label, got:\n${exprToString(labelExpr)}`,
      });
    }

    const label = labelExpr.token.value;
    if (parameter.label !== label) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Named argument is not supported. Label is only used for readibility.
    Expected ${
      parameter ? `label "${parameter.label}"` : `no label`
    } at the argument position, but got "${label}".`,
      });
    }
  }

  // Evaluate the parameter type FIRST - before any argument evaluation
  // This ensures we have the correct parameterType for expectedType in argument evaluation
  const { parameterType, calleeEnv: updatedCalleeEnv } =
    evaluateFunctionParameterTypeAgain({
      functionType,
      parameter,
      calleeEnv,
      context: {
        ...context,
        isEvaluatingFunctionType: true,
      },
    });
  calleeEnv = updatedCalleeEnv;

  // Evaluate the argExpr
  let evaluatedArgExpr: Expr | undefined = undefined;
  // let evaluatedDefaultValueExpr: Expr | undefined = undefined;

  if (
    !argExpr ||
    (exprIsAtom(argExpr) && exprIsAtomOf(argExpr, BuiltinKeywords.undefined))
  ) {
    // Use the default value
    if (parameter.exprs.defaultValueExpr) {
      evaluatedArgExpr = context.evaluateExpression({
        expr: cloneExpr(parameter.exprs.defaultValueExpr),
        env: calleeEnv,
        context: {
          ...context,
        },
      });
      if (evaluatedArgExpr.$?.env) {
        calleeEnv = evaluatedArgExpr.$?.env;
      }
      if (argExpr) {
        argExpr.$ = evaluatedArgExpr.$;
      }
      if (!parameter.isCompileTimeOnly) {
        runtimeArgExprsInOrder.push(evaluatedArgExpr);
      }
    } else {
      throw formatErrorMessage({
        token: argExpr?.token ?? PlaceholderToken,
        errorMessage: `Expected default value for parameter "${parameter.label}"`,
      });
    }
  } else {
    // This is for macro function, no need to evaluate the argExpr
    if (parameter.isQuote) {
      if (isExprType(parameterType)) {
        evaluatedArgExpr = cloneExpr(argExpr);
        evaluatedArgExpr.$ = {
          type: createExprType(),
          value: createExprValue(argExpr),
          env: callerEnv,
          pathCollection: [],
        };
      } else {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Expected "Expr" type for "quote" parameter "${parameter.label}", got:\n${typeToString(
            parameterType
          )}`,
        });
      }
    }
    // This is normal function call parameter
    else {
      evaluatedArgExpr = context.evaluateExpression({
        expr: argExpr,
        env: callerEnv,
        context: {
          ...context,
          // isEvaluatingExprAsType: false,
          expectedType: { type: parameterType, env: calleeEnv },
        },
      });

      if (evaluatedArgExpr.$?.env) {
        callerEnv = evaluatedArgExpr.$?.env;
      }
      if (!parameter.isCompileTimeOnly) {
        runtimeArgExprsInOrder.push(evaluatedArgExpr);
      }

      // If parameter takes ownership, call ___dup on borrowed ARC values
      if (parameter.isOwningTheARCValue && !parameter.isCompileTimeOnly) {
        setExprAsNeedsToCallDup(evaluatedArgExpr, context);
        if (evaluatedArgExpr.$?.env) {
          callerEnv = evaluatedArgExpr.$?.env;
        }
      }
    }
  }

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr?.token ?? PlaceholderToken,
      errorMessage: `Failed to evaluate argument expression.`,
    });
  }

  let argType = evaluatedArgExpr.$.type;

  // Cannot assign runtime parameter to compt parameter
  if (!evaluatedArgExpr.$?.value && parameter.isCompileTimeOnly) {
    throw formatErrorMessage({
      token: argExpr?.token ?? PlaceholderToken,
      errorMessage: `Cannot assign runtime argument to compile-time parameter:\n${
        argExpr ? exprToString(argExpr) : ""
      }`,
    });
  }

  // Add the arg to the environment
  // console.log("(10) addVariableToEnv");
  let argValue = evaluatedArgExpr.$.value;
  if (!parameter.isCompileTimeOnly) {
    argValue = undefined;

    // argType requires compt modifier
    // but the parameter is not compt
    // we need to convert the argType to runtimeType
    // if (typeRequiresComptModifier(argType)) {
    argType = convertComptTypeToRuntimeType({
      type: argType,
      expectedType: parameterType,
      expr: evaluatedArgExpr,
    });

    if (typeRequiresComptModifier(argType)) {
      // We fail to convert to runtime type
      throw formatErrorMessage({
        token: argExpr?.token ?? PlaceholderToken,
        errorMessage: `Cannot convert compile-time type to runtime type for argument:\n${exprToString(
          evaluatedArgExpr
        )}`,
      });
    }
    // }
  }

  const { env: nextEnv } = addVariableToEnv({
    env: calleeEnv,
    variable: {
      name: parameter.label,
      type: argType, // QUESTION: Should we use parameterType here or argType?
      // This might affect assigning Free type arg to Type parameter
      isCompileTimeOnly: parameter.isCompileTimeOnly,
      isImplicit: false,
      value: argValue,
      token: argExpr?.token ?? PlaceholderToken,
      initializedAtToken: argExpr?.token ?? PlaceholderToken,
      consumedAtToken: undefined,
      isOwningTheARCValue: parameter.isOwningTheARCValue,
    },
  });
  calleeEnv = nextEnv;

  // Synthesize the types
  const { expectedEnv, givenEnv } = synthesizeTypes(
    { type: parameterType, env: calleeEnv },
    { type: argType, env: callerEnv }
  );
  calleeEnv = expectedEnv;
  callerEnv = givenEnv;

  // Re-evaluate the parameter type after synthesis to get the resolved type
  const { parameterType: resolvedParameterType, calleeEnv: finalCalleeEnv } =
    evaluateFunctionParameterTypeAgain({
      functionType,
      parameter,
      calleeEnv,
      context: {
        ...context,
        isEvaluatingFunctionType: true,
      },
    });
  calleeEnv = finalCalleeEnv;

  // Compare the types
  if (
    !areTypesCompatible(
      { type: resolvedParameterType, env: calleeEnv },
      { type: argType, env: callerEnv },
      // It's the receiver:
      argIndex === 0 && isMethodCall
    )
  ) {
    throw formatErrorMessage({
      token: argExpr?.token ?? PlaceholderToken,
      errorMessage: `Type mismatch for parameter "${parameter.label}":
    Expected: ${typeToString(resolvedParameterType)}
    Got:   ${typeToString(argType)}`,
    });
  }
  return {
    calleeEnv,
    callerEnv,
    context: { ...context },
    argValue,
    argType,
    parameterType: resolvedParameterType,
  };
}

/**
 * Helper function to extract FunctionValue from a Value
 * Note: Closures are runtime-only values, so we can't extract FunctionValue from them at compile time
 */
export function extractFunctionValue(
  value: Value | undefined
): FunctionValue | undefined {
  if (!value) {
    return undefined;
  }
  if (isFunctionValue(value)) {
    return value;
  }
  // Closures are runtime-only, no FunctionValue available at compile time
  return undefined;
}

/**
 * NOTE: This function will push new frame to the function env,
 * but will not pop frame.
 */
export function tryToCallFunctionWithArguments({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  expr,
  functionValue,
  functionType,
  functionCalleeExpr,
  argExprs,
  callerEnv,
  context,
  isMethodCall,
}: {
  functionValue?: FunctionValue;
  functionType: FunctionType;
  expr?: Expr;
  functionCalleeExpr?: Expr;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
  isMethodCall: boolean;
}): FunctionCallResult {
  if (functionValue) {
    functionType = functionValue.type; // Use the type from the function value
    // Because it might be an anonymous function
    // the parameter names are different from the function type that it's implementing
  }

  let forallArgsExpr: FuncCallExpr | undefined = undefined;
  let implicitArgExprs: Expr[] = [];

  const forallArgValues: {
    value: Value;
    parameterType: Type;
    argType: Type;
  }[] = [];
  const argValues: {
    value: Value | undefined;
    parameterType: Type;
    argType: Type;
  }[] = [];
  const implicitArgValues: {
    value: Value | undefined;
    parameterType: Type;
    argType: Type;
  }[] = [];

  const runtimeArgExprsInOrder: Expr[] = [];

  // Check if there is `forall(...)` argument zone.
  // If yes, then it should be the first argument
  //
  // Check if there is `using(...)` argument zone.
  // If yes, then it should be the last argument
  const newArgExprs: Expr[] = [];
  for (let i = 0; i < argExprs.length; i++) {
    const argExpr = argExprs[i]!;
    if (
      exprIsFunctionCall(argExpr) &&
      exprIsFunctionCallOf(argExpr, BuiltinKeywords.forall)
    ) {
      if (i !== 0) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Expected forall argument to be the first argument, got:\n${exprToString(
            argExpr
          )}`,
        });
      }
      forallArgsExpr = argExpr;
      continue;
    }

    if (
      exprIsFunctionCall(argExpr) &&
      exprIsFunctionCallOf(argExpr, BuiltinKeywords.using)
    ) {
      if (i !== argExprs.length - 1) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Expected implicit argument to be the last argument, got:\n${exprToString(argExpr)}`,
        });
      }
      implicitArgExprs = argExpr.args;
      break;
    }

    newArgExprs.push(argExpr);
  }
  argExprs = newArgExprs;

  // Push new frame to env
  callerEnv = pushEnvFrame(callerEnv);
  // Push new frame to function env
  let calleeEnv = pushEnvFrame(functionType.env);

  if (functionType.SelfType) {
    /*
      let typeValue: TypeValue;
      if (isModuleType(functionType.SelfType)) {
        const existingSelfElement = functionType.SelfType.elements.find(
          (e) => e.label === "Self" && isTypeValue(e.assignedValue)
        );
        if (existingSelfElement) {
          typeValue = existingSelfElement.assignedValue as TypeValue;
        } else {
          typeValue = createTypeValue(functionType.SelfType);
        }
      } else {
        typeValue = createTypeValue(functionType.SelfType);
      }
      */
    const typeValue = createTypeValue(functionType.SelfType);

    // Add "Self" to the calleeEnv
    // console.log("(11) addVariableToEnv");
    const { env: nextEnv } = addVariableToEnv({
      env: calleeEnv,
      variable: {
        name: "Self",
        token: PlaceholderToken,
        type: typeValue.type,
        isCompileTimeOnly: true,
        initializedAtToken: PlaceholderToken, // Set as initialized
        consumedAtToken: undefined,
        isImplicit: false,
        value: typeValue,
      },
    });
    calleeEnv = nextEnv;
  }

  for (let i = 0; i < functionType.forallParameters.length; i++) {
    // Add forallParameter to calleeEnv
    const forallParameter = functionType.forallParameters[i]!;
    let typeParameterVariable: Variable | undefined = undefined;
    // NOTE: No need to add forallParameter to env
    //       It will cause the variable shadowing problem.
    if (forallParameter.exprs.labelExpr && forallParameter.label) {
      // console.log("(12) addVariableToEnv");
      const { env: nextEnv, variable } = addVariableToEnv({
        env: calleeEnv,
        variable: {
          name: forallParameter.label,
          type: forallParameter.type,
          isCompileTimeOnly: true,
          isImplicit: false,
          value: createUnknownValue(
            forallParameter.type,
            forallParameter.label
          ),
          token: forallParameter.exprs.labelExpr.token,
          initializedAtToken: forallParameter.exprs.labelExpr.token, // Set as initialized
          consumedAtToken: undefined,
        },
      });
      calleeEnv = nextEnv;
      typeParameterVariable = variable;
    }

    if (forallArgsExpr) {
      let forallArgExpr: Expr | undefined = forallArgsExpr.args[i];
      let labelExpr: Expr | undefined = undefined;

      // Check if it's calling the named argument
      if (
        exprIsFunctionCall(forallArgExpr) &&
        exprIsFunctionCallOf(forallArgExpr, ":", 2)
      ) {
        labelExpr = forallArgExpr.args[0]!;
        forallArgExpr = forallArgExpr.args[1]!;

        // Check if the label is valid
        if (!exprIsAtom(labelExpr)) {
          throw formatErrorMessage({
            token: labelExpr.token,
            errorMessage: `Expected identifier for type parameter label, got:\n${exprToString(labelExpr)}`,
          });
        }

        // Check if the label matches the type parameter label
        if (forallParameter.label !== labelExpr.token.value) {
          throw formatErrorMessage({
            token: labelExpr.token,
            errorMessage: `Expected type parameter label "${forallParameter.label}", got "${labelExpr.token.value}".`,
          });
        }
      }

      // Check if it's undefined
      let typeValue: Value;
      // Check if it's '_'
      if (exprIsAtom(forallArgExpr) && forallArgExpr.token.value === "_") {
        // _ is a special case, it means to use the inferred type
        // So we don't need to check the type
        continue;
      }
      // Check the default value
      else if (
        !forallArgExpr ||
        (exprIsAtom(forallArgExpr) &&
          exprIsAtomOf(forallArgExpr, BuiltinKeywords.undefined))
      ) {
        // Check if forallParameter has default value
        if (forallParameter.exprs.defaultValueExpr) {
          const evaluatedArgExpr = context.evaluateExpression({
            expr: cloneExpr(forallParameter.exprs.defaultValueExpr),
            env: calleeEnv,
            context: {
              ...context,
            },
          });
          if (evaluatedArgExpr.$?.env) {
            callerEnv = evaluatedArgExpr.$.env;
          }
          if (forallArgExpr) {
            forallArgExpr.$ = evaluatedArgExpr.$;
          }

          if (!isTypeValue(evaluatedArgExpr.$?.value)) {
            throw formatErrorMessage({
              token:
                forallArgExpr?.token ??
                functionCalleeExpr?.token ??
                PlaceholderToken,
              errorMessage: forallArgExpr
                ? `Expected type for default value, got:\n${exprToString(forallArgExpr)}`
                : `Expected type for default value.`,
            });
          }
          typeValue = evaluatedArgExpr.$?.value;
        } else {
          throw formatErrorMessage({
            token:
              forallArgExpr?.token ??
              functionCalleeExpr?.token ??
              PlaceholderToken,
            errorMessage: `Type parameter does not have default value.`,
          });
        }
      } else {
        // Evaluate forallArgExpr
        const evaluatedTypeExpr = context.evaluateExpression({
          expr: forallArgExpr,
          env: callerEnv,
          context: {
            ...context,
            expectedType: { type: forallParameter.type, env: calleeEnv },
          },
        });
        if (evaluatedTypeExpr.$?.env) {
          callerEnv = evaluatedTypeExpr.$.env;
        }
        if (!isTypeValue(evaluatedTypeExpr.$?.value)) {
          throw formatErrorMessage({
            token: forallArgExpr.token,
            errorMessage: `Expected type for argument, got:\n${exprToString(forallArgExpr)}`,
          });
        }
        typeValue = evaluatedTypeExpr.$?.value;
      }

      if (labelExpr) {
        labelExpr.$ = {
          env: calleeEnv, // QUESTION: Which env should we use?
          type: typeValue.type,
          value: typeValue,
          pathCollection: [],
        };
      }

      // Evaluate the forall parameter type first (like we do for regular and implicit parameters)
      const {
        parameterType: evaluatedForallParameterType,
        calleeEnv: updatedCalleeEnv,
      } = evaluateFunctionParameterTypeAgain({
        parameter: forallParameter,
        calleeEnv,
        context: {
          ...context,
          isEvaluatingFunctionType: true,
        },
        functionType,
      });
      calleeEnv = updatedCalleeEnv;

      // Synthesize the types
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: evaluatedForallParameterType, env: calleeEnv },
        { type: typeValue.type, env: callerEnv }
      );
      calleeEnv = expectedEnv;
      callerEnv = givenEnv;

      // Compare the types
      if (
        !areTypesCompatible(
          { type: evaluatedForallParameterType, env: calleeEnv },
          { type: typeValue.type, env: callerEnv }
        )
      ) {
        throw formatErrorMessage({
          token:
            forallArgExpr?.token ??
            functionCalleeExpr?.token ??
            PlaceholderToken,
          errorMessage: `Type mismatch for type parameter "${forallParameter.label}":
Expected: ${typeToString(evaluatedForallParameterType)}
Got:   ${typeToString(typeValue.type)}`,
        });
      }

      // Add the type to the env
      if (forallParameter.label) {
        // console.log("(13) addVariableToEnv");
        if (typeParameterVariable) {
          calleeEnv = updateExistingVariable(calleeEnv, typeParameterVariable, {
            ...typeParameterVariable,
            value: typeValue,
          });
        } else {
          const token =
            forallArgExpr?.token ??
            functionCalleeExpr?.token ??
            PlaceholderToken;
          const { env: nextEnv } = addVariableToEnv({
            env: calleeEnv,
            variable: {
              name: forallParameter.label,
              type: typeValue.type,
              isCompileTimeOnly: true,
              isImplicit: false,
              value: typeValue,
              token: token,
              initializedAtToken: token, // Set as initialized
              consumedAtToken: undefined,
            },
          });
          calleeEnv = nextEnv;
        }
      }

      // Save to forallArgValues
      forallArgValues.push({
        value: typeValue,
        argType: typeValue.type,
        parameterType: evaluatedForallParameterType,
      });
    }
  }

  const expectedArgCount = functionType.parameters.length;

  if (!functionType.variadicParameter && argExprs.length > expectedArgCount) {
    // Check if the last function parameter is quote with ExprList
    // If not then we throw error
    const lastParameter = functionType.parameters.at(-1);
    if (
      lastParameter &&
      lastParameter.isQuote &&
      isExprListType(lastParameter.type)
    ) {
      // Allowed to have more args here
    } else {
      throw formatErrorMessage({
        token: functionCalleeExpr?.token ?? PlaceholderToken,
        errorMessage: `Too many arguments for function call:
Expected: ${expectedArgCount} arguments
Got:   ${argExprs.length} arguments`,
      });
    }
  }

  // Check if the parameters match the arguments
  let regularArgIndex = 0;
  const parametersToProcess = functionType.parameters.length;

  for (
    regularArgIndex = 0;
    regularArgIndex < parametersToProcess;
    regularArgIndex++
  ) {
    const parameter = functionType.parameters[regularArgIndex]!;
    const {
      calleeEnv: nextCalleeEnv,
      callerEnv: nextCallerEnv,
      context: nextContext,
      argValue,
      argType,
      parameterType: newParameterType,
    } = checkIfFunctionParameterMatchesArgument({
      functionType,
      parameter,
      argExprs,
      argIndex: regularArgIndex,
      callerEnv,
      calleeEnv,
      context,
      isMethodCall,
      runtimeArgExprsInOrder,
    });
    calleeEnv = nextCalleeEnv;
    callerEnv = nextCallerEnv;
    context = nextContext;

    argValues.push({
      value: argValue,
      parameterType: newParameterType,
      argType,
    });
  }

  // NOTE: We should handle the returnType before the implicit arguments
  // Evaluate the function return type again
  let {
    returnType,
    // eslint-disable-next-line prefer-const
    calleeEnv: nextCalleeEnv,
  } = evaluateFunctionReturnTypeAgain({
    functionType,
    calleeEnv,
    context: {
      ...context,
      isEvaluatingFunctionType: true,
    },
    functionCalleeExpr,
  });
  calleeEnv = nextCalleeEnv;

  // Synthesize the returnType if context.expectedType is giving
  // The context.expectedType is the expected function return type.
  if (context.expectedType) {
    const { expectedEnv } = synthesizeTypes(
      { type: returnType, env: calleeEnv },
      { type: context.expectedType.type, env: context.expectedType.env }
    );
    calleeEnv = expectedEnv;

    // Evaluate the function return type again after synthesizing
    // This is to ensure that any SomeType in the returnType is properly resolved
    const evalReturnTypeResult = evaluateFunctionReturnTypeAgain({
      functionType,
      calleeEnv,
      context: {
        ...context,
        isEvaluatingFunctionType: true,
      },
      functionCalleeExpr,
    });
    returnType = evalReturnTypeResult.returnType;
    calleeEnv = evalReturnTypeResult.calleeEnv;

    if (
      areTypesCompatible(
        { type: context.expectedType.type, env: context.expectedType.env },
        { type: returnType, env: calleeEnv }
      )
    ) {
      returnType = context.expectedType.type;
    } else {
      // QUESTION: Should we throw error here?
      // ANSWER: It seems like if we throw error here, then some code examples will be broken. I am not sure why
      //       throw formatErrorMessage({
      //         token: expr?.token ?? functionCalleeExpr?.token ?? PlaceholderToken,
      //         errorMessage: `Function return type mismatch:
      // Expected: ${typeToString(context.expectedType.type)}
      // Got:   ${typeToString(returnType)}`,
      //       });
    }
  }

  // Check if the implicit parameters are provided
  for (let i = 0; i < functionType.implicitParameters.length; i++) {
    const implicitParameter = functionType.implicitParameters[i]!;

    // Evaluate its type again
    const {
      parameterType: newImplicitParameterType,
      calleeEnv: nextCalleeEnv,
    } = evaluateFunctionParameterTypeAgain({
      functionType,
      parameter: implicitParameter,
      calleeEnv,
      context: {
        ...context,
        isEvaluatingFunctionType: true,
      },
    });
    calleeEnv = nextCalleeEnv;
    const implicitParameterType = newImplicitParameterType;

    // When evaluating function types, assume implicit parameters will be satisfied
    if (context.isEvaluatingFunctionType) {
      // Create an unknown value for the implicit parameter
      const unknownValue = createUnknownValue(
        implicitParameterType,
        implicitParameter.label
      );

      // Add the parameter to the calleeEnv
      const { env: nextEnv } = addVariableToEnv({
        env: calleeEnv,
        variable: {
          name: implicitParameter.label,
          type: implicitParameterType,
          isCompileTimeOnly: implicitParameter.isCompileTimeOnly,
          isImplicit: false,
          value: unknownValue,
          token: PlaceholderToken,
          initializedAtToken: PlaceholderToken,
          consumedAtToken: undefined,
        },
      });
      calleeEnv = nextEnv;

      implicitArgValues.push({
        value: unknownValue,
        parameterType: implicitParameterType,
        argType: implicitParameter.type,
      });

      continue; // Skip the actual dependency resolution
    }

    // Check if it's provided in implicitArgsExpr
    let implicitArgExpr: Expr | undefined = implicitArgExprs[i];
    let labelExpr: Expr | undefined = undefined;

    // Check if it's calling the named argument
    if (
      exprIsFunctionCall(implicitArgExpr) &&
      exprIsFunctionCallOf(implicitArgExpr, ":", 2)
    ) {
      labelExpr = implicitArgExpr.args[0]!;
      implicitArgExpr = implicitArgExpr.args[1]!;

      // Check if the label is valid
      if (!exprIsAtom(labelExpr)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Expected identifier for type parameter label, got:\n${exprToString(labelExpr)}`,
        });
      }

      // Check if the label matches the type parameter label
      if (implicitParameter.label !== labelExpr.token.value) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Expected type parameter label "${implicitParameter.label}", got "${labelExpr.token.value}".`,
        });
      }
    }

    // Check if it's '_'
    if (
      !implicitArgExpr ||
      (exprIsAtom(implicitArgExpr) && implicitArgExpr.token.value === "_")
    ) {
      // _ is a special case, it means to use the inferred value.
      // So we don't need to check the type
    }
    // NOTE: Default value is not supported for implicit parameters
    else {
      // Evaluate the given implicit argument
      const evaluatedImplicitArg = context.evaluateExpression({
        expr: implicitArgExpr,
        env: callerEnv,
        context: {
          ...context,
          expectedType: { type: implicitParameterType, env: calleeEnv },
        },
      });
      if (evaluatedImplicitArg.$?.env) {
        callerEnv = evaluatedImplicitArg.$.env;
      }
      const argType = evaluatedImplicitArg.$?.type;
      if (!argType) {
        throw formatErrorMessage({
          token: implicitArgExpr.token,
          errorMessage: `Failed to evaluate implicit argument expression:\n${exprToString(implicitArgExpr)}`,
        });
      }

      // Add the arg to the environment
      if (implicitParameter.label) {
        const argValue = evaluatedImplicitArg.$?.value;
        // console.log("(14) addVariableToEnv");
        const { env: nextEnv } = addVariableToEnv({
          env: calleeEnv,
          variable: {
            name: implicitParameter.label,
            type: argType,
            isCompileTimeOnly: implicitParameter.isCompileTimeOnly,
            isImplicit: false,
            value: argValue,
            token: implicitArgExpr.token,
            initializedAtToken: implicitArgExpr.token, // Set as initialized
            consumedAtToken: undefined, // Not consumed yet
          },
        });
        calleeEnv = nextEnv;
      }

      // Synthesize the types
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: implicitParameterType, env: calleeEnv },
        { type: argType, env: callerEnv }
      );
      calleeEnv = expectedEnv;
      callerEnv = givenEnv;

      // Compare the types
      if (
        !areTypesCompatible(
          { type: implicitParameterType, env: calleeEnv },
          { type: argType, env: callerEnv }
        )
      ) {
        throw formatErrorMessage({
          token: implicitArgExpr.token,
          errorMessage: `Type mismatch for implicit parameter "${implicitParameter.label}":
Expected: ${typeToString(implicitParameterType)}
Got:   ${typeToString(argType)}`,
        });
      }
      continue; // Found the correct implicit argument
    }

    // =====

    // Check in the env if implicit variable of such type exists
    const implicitFunctionCalls: {
      returnType: Type;
      returnValue: Value | undefined;
      calleeEnv: Environment;
      callerEnv: Environment;
      variable: Variable;
    }[] = [];

    let implicitVariables = getVariablesFromEnvByFilter(
      callerEnv,
      (variable) => {
        if (
          !variable.isImplicit ||
          variable.isCompileTimeOnly !== implicitParameter.isCompileTimeOnly
        ) {
          return false;
        }

        // First synthesize types to allow unification of SomeTypes with concrete types
        const {
          expectedEnv: synthesizedCalleeEnv,
          givenEnv: synthesizedCallerEnv,
        } = synthesizeTypes(
          { type: implicitParameterType, env: calleeEnv },
          { type: variable.type, env: callerEnv }
        );

        // Check if type matches
        const isCompatible = areTypesCompatible(
          { type: implicitParameterType, env: synthesizedCalleeEnv },
          { type: variable.type, env: synthesizedCallerEnv }
        );

        if (isCompatible) {
          return true;
        }

        // Check if it's a function that has no parameters.
        // (can have type parameters, and implicit parameters).
        // Then try to call that function to check if its return type can
        // match the implicit parameter type
        if (isFunctionType(variable.type)) {
          const funcType = variable.type;
          if (funcType.parameters.length === 0) {
            const funcValue = variable.value;

            if (!!funcValue && !!functionValue && funcValue === functionValue) {
              // Prevent infinite loop
              return false;
            }

            if (!(!funcValue || isFunctionValue(funcValue))) {
              return false;
            }

            try {
              // FIXME: Prevent circular call
              const {
                returnType,
                returnValue,
                calleeEnv: nextCalleeEnv,
                callerEnv: nextCallerEnv,
              } = tryToCallFunctionWithArguments({
                argExprs: [],
                callerEnv,
                functionType: funcType,
                functionValue: funcValue,
                functionCalleeExpr: undefined, // FIXME: <- this is the wrong expr
                context: {
                  ...context,
                  expectedType: {
                    type: implicitParameterType,
                    env: calleeEnv,
                  },
                },
                isMethodCall: false,
              });
              const matched = areTypesCompatible(
                { type: returnType, env: nextCallerEnv },
                { type: implicitParameterType, env: nextCalleeEnv }
              );
              if (matched) {
                implicitFunctionCalls.push({
                  returnType,
                  returnValue,
                  calleeEnv: nextCalleeEnv,
                  callerEnv: nextCallerEnv,
                  variable,
                });
              }

              return matched;
            } catch {
              // Failed
            }
          }
        }

        // Check if the variable module value matches the expected implicitParameterType
        if (
          isModuleType(implicitParameterType) &&
          isTypeValue(variable.value)
        ) {
          const type = variable.value.value;
          if (
            isStructType(type) ||
            isEnumType(type) ||
            isUnionType(type) ||
            isClosureType(type) ||
            isFutureType(type)
          ) {
            const module = type.module;
            for (let i = 0; i < module.elements.length; i++) {
              const moduleElement = module.elements[i]!;
              if (isModuleValue(moduleElement.assignedValue)) {
                const moduleValue = moduleElement.assignedValue;
                if (
                  areTypesCompatible(
                    { type: moduleValue.type, env: callerEnv },
                    { type: implicitParameterType, env: calleeEnv }
                  )
                ) {
                  implicitFunctionCalls.push({
                    returnType: moduleValue.type,
                    returnValue: moduleValue,
                    calleeEnv,
                    callerEnv,
                    variable,
                  });
                  return true;
                }
              }
            }
          }
        }

        return false;
      }
    );
    // Get the max frame level of the implicit variables
    // This is to ensure that we get the most recent implicit variable
    const maxImplicitVariableFrameLevel = Math.max(
      ...implicitVariables.map((variable) => variable.frameLevel)
    );
    implicitVariables = implicitVariables.filter(
      (variable) => variable.frameLevel === maxImplicitVariableFrameLevel
    );

    if (implicitVariables.length === 0) {
      throw formatErrorMessage({
        token: functionCalleeExpr?.token ?? PlaceholderToken,
        errorMessage: `Implicit parameter is not provided. Expected:
given(${implicitParameter.label}) :\n  ${typeToString(implicitParameterType)}`,
      });
    }

    if (implicitVariables.length > 1) {
      throw formatErrorMessage({
        token: functionCalleeExpr?.token ?? PlaceholderToken,
        errorMessage: `Ambiguous implicit parameter:
${implicitParameter.label ? `(${implicitParameter.label} : ${typeToString(implicitParameterType)})` : typeToString(implicitParameterType)}

Found:
${implicitVariables
  .map((variable) => {
    return `- ${variable.name} : ${typeToString(variable.type)}`;
  })
  .join("\n")}
`,
      });
    }

    // Add the implicit variable to the function env
    const implicitVariable = implicitVariables[0]!;

    // Check if it's from an implicit function call or type module
    if (
      (isFunctionType(implicitVariable.type) || // implicit function
        isTypeValue(implicitVariable.value)) && // implicit type module
      implicitFunctionCalls.find((c) => c.variable === implicitVariable)
    ) {
      const implicitFunctionCallResult = implicitFunctionCalls.find(
        (c) => c.variable === implicitVariable
      )!;
      const { returnType, returnValue } = implicitFunctionCallResult;

      const { env: nextEnv } = addVariableToEnv({
        env: calleeEnv,
        variable: {
          name: implicitParameter.label,
          type: returnType,
          isCompileTimeOnly: implicitVariable.isCompileTimeOnly,
          isImplicit: implicitVariable.isImplicit,
          value: returnValue,
          token: functionCalleeExpr?.token ?? PlaceholderToken,
          initializedAtToken: functionCalleeExpr?.token ?? PlaceholderToken, // Set as initialized
          consumedAtToken: undefined, // Not consumed yet
        },
        skipCheckingFunctionOverloading: true,
      });
      calleeEnv = nextEnv;

      // Add the implicit variable value to the implicitArgValues
      implicitArgValues.push({
        value: returnValue,
        argType: returnType,
        parameterType: implicitParameterType,
      });
      // NOTE: In theory, all implicitParameter are compile-time-only now.
      if (!implicitParameter.isCompileTimeOnly) {
        runtimeArgExprsInOrder.push({
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: implicitVariable.name,
              inputString: implicitVariable.token.inputString,
              modulePath: implicitVariable.token.modulePath,
              position: implicitVariable.token.position,
            },
            $: {
              env: calleeEnv,
              type: implicitVariable.type,
              value: implicitVariable.value,
              pathCollection: [],
            },
          },
          args: [],
          token: {
            type: TokenType.Identifier,
            value: implicitVariable.name,
            inputString: implicitVariable.token.inputString,
            modulePath: implicitVariable.token.modulePath,
            position: implicitVariable.token.position,
          },
          $: {
            env: calleeEnv,
            type: returnType,
            value: returnValue,
            pathCollection: [],
          },
        });
      }
    } else {
      // console.log("(15) addVariableToEnv");
      const { env: nextEnv } = addVariableToEnv({
        env: calleeEnv,
        variable: {
          name: implicitParameter.label,
          type: implicitVariable.type,
          isCompileTimeOnly: implicitVariable.isCompileTimeOnly,
          isImplicit: implicitVariable.isImplicit,
          value: implicitVariable.value,
          token: functionCalleeExpr?.token ?? PlaceholderToken,
          initializedAtToken: functionCalleeExpr?.token ?? PlaceholderToken, // Set as initialized
          consumedAtToken: undefined, // Not consumed yet
        },
        skipCheckingFunctionOverloading: true,
      });
      calleeEnv = nextEnv;

      // Add the implicit variable value to the implicitArgValues
      implicitArgValues.push({
        value: implicitVariable.value,
        argType: implicitVariable.type,
        parameterType: implicitParameterType,
      });
      if (!implicitParameter.isCompileTimeOnly) {
        runtimeArgExprsInOrder.push({
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Identifier,
            value: implicitVariable.name,
            inputString: implicitVariable.token.inputString,
            modulePath: implicitVariable.token.modulePath,
            position: implicitVariable.token.position,
          },
          $: {
            env: calleeEnv,
            type: implicitVariable.type,
            value: implicitVariable.value,
            pathCollection: [],
          },
        });
      }
    }
  }

  // Check the variadic parameters
  const variadicArgs: { value: Value | undefined; argType: Type }[] = [];
  if (functionType.variadicParameter) {
    for (; regularArgIndex < argExprs.length; regularArgIndex++) {
      const argExpr = argExprs[regularArgIndex]!;
      let evaluatedArgExpr: Expr;
      if (functionType.variadicParameter.isQuote) {
        // Macro
        evaluatedArgExpr = cloneExpr(argExpr);
        evaluatedArgExpr.$ = {
          type: createExprType(),
          value: createExprValue(argExpr),
          env: callerEnv,
          pathCollection: [],
        };
        variadicArgs.push({
          value: evaluatedArgExpr.$.value,
          argType: evaluatedArgExpr.$.type,
        });
      } else {
        // Evaluate the argument expression
        evaluatedArgExpr = context.evaluateExpression({
          expr: argExpr,
          env: callerEnv,
          context: {
            ...context,
          },
        });
        if (!evaluatedArgExpr.$?.env) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Failed to evaluate the expression:\n${exprToString(argExpr)}`,
          });
        }
        callerEnv = evaluatedArgExpr.$.env;
        variadicArgs.push({
          value: evaluatedArgExpr.$.value,
          argType: evaluatedArgExpr.$.type,
        });

        if (!functionType.variadicParameter.isCompileTimeOnly) {
          // TODO: For VarList type, we should add arg_count as parameter
          runtimeArgExprsInOrder.push(argExpr);
        }
      }
    }

    // TODO: Check borrowings

    if (functionType.variadicParameter.label === "...") {
      // Do nothing
    } else if (functionType.variadicParameter.isQuote) {
      // Create the ExprList and add that to environment
      const exprListValue = createExprListValue(
        variadicArgs.map((arg) => arg.value as ExprValue)
      );

      // Add to env
      const { env: nextEnv } = addVariableToEnv({
        env: calleeEnv,
        variable: {
          name: functionType.variadicParameter.label,
          type: exprListValue.type, // QUESTION: Should we use parameterType here or argType?
          // This might affect assigning Free type arg to Type parameter
          isCompileTimeOnly: functionType.variadicParameter.isCompileTimeOnly,
          isImplicit: false,
          value: exprListValue,
          token: functionType.variadicParameter.exprs.expr.token,
          initializedAtToken: functionType.variadicParameter.exprs.expr.token,
          consumedAtToken: undefined,
        },
      });
      calleeEnv = nextEnv;
    }
  }

  // if (exprToString(functionType.return.expr) === "Wrapper2(A)") {
  //   console.log("before Wrapper2(A): ");
  //   printEnvVarNames(calleeEnv);
  // }

  // console.log("\nFunction call: ", exprToString(expr));
  // console.log("- return expr: ", exprToString(functionType.return.expr));
  // console.log(
  //   "- SelfType:",
  //   context.SelfType ? typeToString(context.SelfType) : undefined
  // );
  // console.log(
  //   "- functionValue?.SelfType:",
  //   functionValue?.SelfType ? typeToString(functionValue.SelfType) : undefined
  // );

  const pathCollection: PathCollection = [];

  const argValues_: ArgValues = {
    args: argValues,
    forallArgs: forallArgValues,
    implicitArgs: implicitArgValues,
    variadicArgs,
  };

  // Check if we need to evaluate the compt function call
  // such as the type function, macro function, or function that returns compt value.
  let returnValue: Value | undefined;
  /// Compile-time
  if (functionType.return.isCompileTimeOnly) {
    if (isFunctionValue(functionValue)) {
      const {
        value: nextReturnValue,
        callerEnv: nextCallerEnv,
        calleeEnv: nextCalleeEnv,
      } = evaluateComptFunctionCall({
        functionCalleeExpr,
        functionType,
        functionValue,
        argValues: argValues_,
        callerEnv: callerEnv,
        calleeEnv: calleeEnv,
        context: {
          ...context,
          // Keep the original validation state - don't override it
        },
      });
      returnValue = nextReturnValue;
      returnType = nextReturnValue.type;
      callerEnv = nextCallerEnv;
      calleeEnv = nextCalleeEnv;
    } else {
      // NOTE: The returnType might be a SomeType that we already synthesized
      //     in this case, we need to try to get its synthesized value from the callerEnv.
      const isSomeType =
        isTypeHierarchyType(returnType) && returnType.level === 0;
      const someTypeId = `${functionType.id}_return_sometype`;

      if (isSomeType) {
        if (context.expectedType?.type) {
          returnValue = createTypeValue(context.expectedType.type);
        } else {
          if (context.isEvaluatingFunctionType) {
            const someType = createSomeType(
              returnType as TypeHierarchyType,
              functionType.return.label,
              someTypeId
            );
            someType.functionApplication = expr;
            const newReturnType = getValueOfSomeTypeFromEnv(
              calleeEnv,
              someType
            );
            returnValue = createTypeValue(newReturnType);
          } else {
            throw formatErrorMessage({
              token:
                expr?.token ?? functionCalleeExpr?.token ?? PlaceholderToken,
              errorMessage: `Cannot infer compt return type. Please provide the expected type.`,
            });
          }
        }
      } else {
        returnValue = createUnknownValue(returnType, functionType.return.label);
      }
    }
  }

  validateFunctionReturnType({
    returnType,
    env: callerEnv, // Use callerEnv directly to check SomeTypes are in scope
    expr,
    context,
  });

  // Check if function has compile-time parameters and create specialized version if needed
  let specializedFunctionValue: FunctionValue | undefined;

  if (
    functionValue &&
    isFunctionValue(functionValue) && // functionValue might be UnknownValue, so this condition check is necessary
    isFunctionSpecializable(functionType)
  ) {
    specializedFunctionValue = createSpecializedFunctionInline({
      originalFunction: functionValue,
      argValues: argValues_,
      calleeEnv: calleeEnv,
      callerEnv: callerEnv,
      context,
    });
  }

  // Handle automatic drop insertion for RAII before returning from function call
  // Get variables that need drop calls from the caller environment (function arguments)
  const variablesNeedingDrop = getVariablesNeedingDrop(callerEnv);

  // Generate deferred drop expressions for all variables that need cleanup
  let deferredDropExpressions: Expr[] | undefined = undefined;
  if (variablesNeedingDrop.length > 0) {
    const dropResult = generateDeferredDropExpressions({
      variablesToDrop: variablesNeedingDrop,
      env: callerEnv,
      context,
    });
    deferredDropExpressions = dropResult.deferredDropExpressions;

    callerEnv = dropResult.env;
  }

  return {
    returnType,
    calleeEnv,
    callerEnv,
    pathCollection,
    argValues: argValues_,
    returnValue,
    specializedFunctionValue,
    runtimeArgExprsInOrder,
    deferredDropExpressions,
  };
}

/**
 * Create a specialized function inline within tryToCallFunctionWithArguments
 */
function createSpecializedFunctionInline({
  originalFunction,
  argValues,
  calleeEnv,
  callerEnv,
  context,
}: {
  originalFunction: FunctionValue;
  argValues: ArgValues;
  calleeEnv: Environment;
  callerEnv: Environment;
  context: EvaluatorContext;
}): FunctionValue {
  const functionType = originalFunction.type;

  // Extract compile-time argument values for caching
  const compileTimeArgValues: Value[] = [];
  const runtimeParameters: FunctionParameter[] = [];

  // Add forall type arguments (always compile-time)
  if (argValues.forallArgs) {
    compileTimeArgValues.push(...argValues.forallArgs.map((v) => v.value));
  }

  // Add regular compile-time parameters
  functionType.parameters.forEach((param, index) => {
    const arg = argValues.args[index]!;
    if (param.isCompileTimeOnly) {
      if (arg.value) {
        compileTimeArgValues.push(arg.value);
      }
    } else {
      runtimeParameters.push({ ...param, type: arg.parameterType });
    }
  });

  // Add implicit compile-time parameters
  if (argValues.implicitArgs) {
    functionType.implicitParameters.forEach((param, index) => {
      const implicitArg = argValues.implicitArgs![index]!;
      if (param.isCompileTimeOnly) {
        if (implicitArg?.value) {
          compileTimeArgValues.push(implicitArg.value);
        }
      } else {
        runtimeParameters.push({
          ...param,
          type: implicitArg.parameterType,
        });
      }
    });
  }

  // Check if we already have a specialized version in cache
  const existingCache = originalFunction.specializedFunctionCaches.find(
    (cache) =>
      cache.compileTimeArgValues.length === compileTimeArgValues.length &&
      cache.compileTimeArgValues.every((cachedValue, index) => {
        const currentValue = compileTimeArgValues[index]!;

        // Use areValuesEqual for robust comparison
        return areValuesEqual(
          { value: cachedValue, env: cache.env },
          { value: currentValue, env: callerEnv }
        );
      })
  );

  if (existingCache) {
    return existingCache.specializedFunction;
  }

  // Create specialized environment with compile-time arguments bound
  const specializedEnv = calleeEnv;

  // Clone the function body and evaluate it in the specialized environment
  const clonedBody = cloneExpr(originalFunction.body);

  // Evaluate the function body in the specialized environment
  const specializedBody = evaluateBeginExpression({
    expr: clonedBody,
    env: specializedEnv,
    context: {
      ...context,
      // expectedType: { // NOTE: Using functionType.return.type as expected type is wrong if it contains SomeType.
      // QUESTION: Should we call resolveSomeTypeInType here?
      //   type: functionType.return.type,
      //   env: specializedEnv,
      // },
      isEvaluatingFunctionBodyOrAsyncBlock: {
        kind: "function-body",
        type: functionType,
        value: originalFunction,
        evaluationEnv: specializedEnv,
      },
      capturedVariables: functionType.isClosure
        ? new Map<string, CapturedVariableInfo>()
        : undefined,
    },
    variablesToAdd: [],
    isEvaluatingFunctionBodyBeginBlock: true,
  });
  if (!specializedBody.$) {
    throw formatErrorMessage({
      token: originalFunction.body.token,
      errorMessage: `Failed to evaluate function body for specialization.`,
    });
  }

  // Resolve the return type by re-evaluating it in the specialized environment
  // This is analogous to how we resolve parameter types using evaluateFunctionParameterTypeAgain
  const {
    returnType: specializedReturnType,
    calleeEnv: _updatedSpecializedEnv,
  } = evaluateFunctionReturnTypeAgain({
    functionType,
    calleeEnv: specializedEnv,
    context: {
      ...context,
      isEvaluatingFunctionType: true,
    },
    functionCalleeExpr: undefined,
  });

  // Create signature for the specialized function
  const compileTimeSignatureParts: string[] = [];

  // Include forall type arguments
  // In theory all the forallArgs should be compile-time arguments
  functionType.forallParameters.forEach((param, index) => {
    if (index < argValues.forallArgs.length) {
      const arg = argValues.forallArgs[index]!;
      compileTimeSignatureParts.push(
        sanitizeForCIdentifier(valueToString(arg.value))
      );
    } else {
      const label = param.label;
      // Check if it's in the calleeEnv
      // Its value might be available after synthesizing types
      const variables = getVariablesFromEnv(calleeEnv, label);
      if (variables.length > 0 && variables[variables.length - 1]?.value) {
        compileTimeSignatureParts.push(
          sanitizeForCIdentifier(
            valueToString(variables[variables.length - 1]!.value)
          )
        );
      } else {
        compileTimeSignatureParts.push("unknown");
      }
    }
  });

  // Include compile-time regular parameters
  functionType.parameters.forEach((param, index) => {
    if (param.isCompileTimeOnly && index < argValues.args.length) {
      const arg = argValues.args[index];
      if (arg) {
        compileTimeSignatureParts.push(
          sanitizeForCIdentifier(valueToString(arg.value))
        );
      } else {
        compileTimeSignatureParts.push("unknown");
      }
    }
  });

  // Include compile-time implicit parameters
  functionType.implicitParameters.forEach((param, index) => {
    if (param.isCompileTimeOnly && index < argValues.implicitArgs!.length) {
      const arg = argValues.implicitArgs![index];
      if (arg) {
        compileTimeSignatureParts.push(
          sanitizeForCIdentifier(valueToString(arg.value))
        );
      } else {
        compileTimeSignatureParts.push("unknown");
      }
    }
  });

  const compileTimeSignature = compileTimeSignatureParts.join("_");

  const specializedFunctionType = createFunctionType({
    forallParameters: [],
    parameters: runtimeParameters,
    implicitParameters: [],
    variadicParameter: undefined, // QUESTION: Is this right?
    return_: {
      ...functionType.return,
      type: specializedReturnType,
    },
    parametersFrame: specializedEnv.frames[specializedEnv.frames.length - 1]!, // QUESTION: This could be wrong
    env: functionType.env,
    SelfType: functionType.SelfType,
    ModuleType: functionType.ModuleType,
    isClosure: functionType.isClosure, // Preserve closure property
  });

  // console.log(
  //   "generate specialized function:",
  //   `${originalFunction.funcName}_${compileTimeSignature}`,
  //   argValues.forallArgs
  // );

  // Create a new specialized function value with the evaluated body
  const specializedFunction: FunctionValue = {
    ...originalFunction,
    specializedType: specializedFunctionType,
    body: specializedBody,
    // Use a signature-based ID for the specialized function
    funcId: `${originalFunction.funcId}_${compileTimeSignature}`,
    funcName: `${originalFunction.funcName}_${compileTimeSignature}`,
    // Initialize cache arrays for the specialized function
    calledComptFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Cache the specialized function in the original function's cache
  const newCache: SpecializedFunctionCache = {
    funcId: originalFunction.funcId,
    compileTimeArgValues,
    specializedFunction,
    env: specializedBody.$.env,
  };

  originalFunction.specializedFunctionCaches = [
    ...originalFunction.specializedFunctionCaches,
    newCache,
  ];

  return specializedFunction;
}

/**
 * Check if the returnType contains any SomeType that doesn't exist in the callerEnv;
 * If yes, then throw error
 */
export function validateFunctionReturnType({
  returnType,
  expr,
  env,
  context,
}: {
  returnType: Type;
  expr: Expr | undefined;
  env: Environment;
  context: EvaluatorContext;
}): void {
  if (context.isEvaluatingFunctionType || context.expectedType) {
    return;
  }

  const returnTypeSomeTypes = getAllSomeTypes(returnType);
  for (const returnTypeSomeType of returnTypeSomeTypes) {
    const variables = getVariablesFromEnv(env, returnTypeSomeType.name);
    if (!variables.length) {
      // Check if this SomeType exists within the types of other variables
      // For example, if T = KeyValuePair(K, V), and we're looking for K,
      // then K exists transitively through T
      const allVariables = getVariablesFromEnvByFilter(env, () => true);
      let foundTransitively = false;

      for (const variable of allVariables) {
        if (isTypeValue(variable.value)) {
          const typeValue = variable.value.value;
          const transitiveTypes = getAllSomeTypes(typeValue);
          for (const transitiveType of transitiveTypes) {
            if (transitiveType.name === returnTypeSomeType.name) {
              foundTransitively = true;
              break;
            }
          }
          if (foundTransitively) break;
        }
      }

      if (foundTransitively) {
        continue; // SomeType found transitively, validation passes
      }

      // Throw error if SomeType value is not found.
      throw formatErrorMessage({
        token: expr?.token ?? PlaceholderToken,
        errorMessage: `Failed to infer the function call return type.
Please consider providing the expected type.`,
      });
    }
  }
}
