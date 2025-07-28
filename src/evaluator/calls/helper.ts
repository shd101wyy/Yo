import { checkBorrowings } from "../../borrow";
import { sanitizeForCIdentifier } from "../../codegen/utils";
import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  getVariablesFromEnvByFilter,
  pushEnvFrame,
  updateExistingVariable,
  Variable,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
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
  setExprAsConsumed,
} from "../../expr";
import { FunctionValue, SpecializedFunctionCache } from "../../function-value";
import { PlaceholderToken, TokenType } from "../../token";
import {
  areTypesCompatible,
  convertComptTypeToRuntimeType,
  createExprType,
  createFunctionType,
  FunctionParameter,
  FunctionType,
  isExprListType,
  isExprType,
  isFunctionSpecializable,
  isFunctionType,
  isMutRefType,
  isRefType,
  Type,
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
  isClosureValue,
  isFunctionValue,
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
import { synthesizeTypes } from "../types/synthesizer";
import { evaluateComptFunctionCall } from "./compt_function";

export function evaluateFunctionParameterType({
  parameter,
  calleeEnv,
  context,
  functionValue,
}: {
  parameter: FunctionParameter;
  calleeEnv: Environment;
  context: EvaluatorContext;
  functionValue: FunctionValue | undefined;
}): { parameterType: Type; calleeEnv: Environment } {
  const typeExpr = parameter.exprs.typeExpr;
  const defaultValueExpr = parameter.exprs.defaultValueExpr;
  if (typeExpr) {
    const evaluatedTypeExpr = context.evaluateExpression({
      expr: cloneExpr(typeExpr),
      env: calleeEnv,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: functionValue?.SelfType,
      },
    });
    if (!isTypeValue(evaluatedTypeExpr.$?.value)) {
      throw formatErrorMessage({
        token: typeExpr.token,
        errorMessage: `Expected type for parameter, got:\n${exprToString(evaluatedTypeExpr)}`,
      });
    }
    if (evaluatedTypeExpr.$?.env) {
      calleeEnv = evaluatedTypeExpr.$?.env;
    }
    const parameterType = evaluatedTypeExpr.$?.value.value;
    return {
      parameterType,
      calleeEnv,
    };
  } else if (defaultValueExpr) {
    const evaluatedDefaultValueExpr = context.evaluateExpression({
      expr: cloneExpr(defaultValueExpr),
      env: calleeEnv,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: functionValue?.SelfType,
      },
    });
    if (!evaluatedDefaultValueExpr.$) {
      throw formatErrorMessage({
        token: defaultValueExpr.token,
        errorMessage: `Failed to evaluate default value expression:\n${exprToString(defaultValueExpr)}`,
      });
    }
    calleeEnv = evaluatedDefaultValueExpr.$?.env;

    /*
    const value = evaluatedDefaultValueExpr.$?.value;
    if (!value) {
      throw formatErrorMessage({
        token: defaultValueExpr.token,
        errorMessage: `Expected value for parameter, got:\n${exprToString(defaultValueExpr)}`,
      });
    }
    */

    const parameterType = evaluatedDefaultValueExpr.$.type; // value.type;
    // NOTE: Using value.type is wrong here.
    // value might be i32,
    // but expr type is Type, not Free.
    return {
      parameterType,
      calleeEnv,
    };
  } else {
    // For anonymous functions, the parameter type is already known and doesn't need evaluation
    return {
      parameterType: parameter.type,
      calleeEnv,
    };
  }
}

export function checkIfFunctionParameterMatchesArgument({
  functionValue,
  parameter,
  argExprs,
  argIndex,
  calleeEnv,
  callerEnv,
  context,
  isMethodCall,
  runtimeArgExprsInOrder,
}: {
  functionValue?: FunctionValue;
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

  let parameterType = parameter.type;
  if (isFunctionType(parameterType)) {
    // Evaluate the parameter type again.
    // This is for anonymous function type that contains type parameter
    // for example:
    //    (forall(T: Type), x: T, callback: ((v: T)-> T))-> T
    // and we call it:
    //    generic_fn(1, fn(x)-> add(x, 1));
    // We can infer `T` is `i32`,
    // But when we evaluate `callback`, we need to evaluate its type again
    // before we evluate the arg

    const { parameterType: newParameterType, calleeEnv: nextCalleeEnv } =
      evaluateFunctionParameterType({
        parameter,
        calleeEnv,
        context: {
          ...context,
        },
        functionValue,
      });
    parameterType = newParameterType;
    calleeEnv = nextCalleeEnv;
  }

  // Evaluate the argExpr
  let evaluatedArgExpr: Expr | undefined = undefined;
  let borrowings = context.borrowings;
  let evaluatedDefaultValueExpr: Expr | undefined = undefined;

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
      evaluatedDefaultValueExpr = evaluatedArgExpr;
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
          isMutable: false,
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
    }
  }

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr?.token ?? PlaceholderToken,
      errorMessage: `Failed to evaluate argument expression.`,
    });
  }

  // Check the borrowings
  if (
    evaluatedArgExpr.$.type &&
    (isMutRefType(evaluatedArgExpr.$.type) ||
      isRefType(evaluatedArgExpr.$.type))
  ) {
    checkBorrowings(context.borrowings, evaluatedArgExpr);

    // Add evaluated arg expr to the borrowings
    borrowings = borrowings.concat([
      {
        expr: evaluatedArgExpr,
        type: evaluatedArgExpr.$.type,
        pathCollection: evaluatedArgExpr.$.pathCollection,
      },
    ]);
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
    argType = convertComptTypeToRuntimeType(argType, parameterType);

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
      isMutable: parameter.isMutable,
      isCompileTimeOnly: parameter.isCompileTimeOnly,
      isImplicit: false,
      value: argValue,
      token: argExpr?.token ?? PlaceholderToken,
      initializedAtToken: argExpr?.token ?? PlaceholderToken,
      consumedAtToken: undefined,
    },
  });
  calleeEnv = nextEnv;

  // Set the arg expr as consumed
  // NOTE: If we evaluated the default value expression,
  // then we don't set the arg expr as consumed,
  // because that's the expression from parameter.exprs.defaultValueExpr
  if (!evaluatedDefaultValueExpr) {
    callerEnv = setExprAsConsumed(evaluatedArgExpr, callerEnv, context);
  }

  // Synthesize the types
  const { expectedEnv, givenEnv } = synthesizeTypes(
    { type: parameterType, env: calleeEnv },
    { type: argType, env: callerEnv }
  );
  calleeEnv = expectedEnv;
  callerEnv = givenEnv;

  // Evaluate the parameter type again
  const { parameterType: newParameterType, calleeEnv: nextCalleeEnv } =
    evaluateFunctionParameterType({
      parameter,
      calleeEnv,
      context: {
        ...context,
      },
      functionValue,
    });
  parameterType = newParameterType;
  calleeEnv = nextCalleeEnv;

  // Compare the types
  if (
    !areTypesCompatible(
      { type: parameterType, env: calleeEnv },
      { type: argType, env: callerEnv },
      // It's the receiver:
      argIndex === 0 && isMethodCall
    )
  ) {
    throw formatErrorMessage({
      token: argExpr?.token ?? PlaceholderToken,
      errorMessage: `Type mismatch for parameter "${parameter.label}":
    Expected: ${typeToString(parameterType)}
    Got:   ${typeToString(argType)}`,
    });
  }
  return {
    calleeEnv,
    callerEnv,
    context: { ...context, borrowings },
    argValue,
    argType,
    parameterType: newParameterType,
  };
}

/**
 * Helper function to extract FunctionValue from either a FunctionValue or ClosureValue
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
  if (isClosureValue(value)) {
    return value.functionValue;
  }
  return undefined;
}

/**
 * NOTE: This function will push new frame to the function env,
 * but will not pop frame.
 */
export function tryToCallFunctionWithArguments({
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
  functionCalleeExpr?: Expr;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
  isMethodCall: boolean;
}): FunctionCallResult {
  const initialBorrowings = [...context.borrowings];

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
        isMutable: false,
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
          isMutable: false,
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
          isMutable: false,
          pathCollection: [],
        };
      }

      // Compare the types
      if (
        !areTypesCompatible(
          { type: forallParameter.type, env: calleeEnv },
          { type: typeValue.type, env: callerEnv }
        )
      ) {
        throw formatErrorMessage({
          token:
            forallArgExpr?.token ??
            functionCalleeExpr?.token ??
            PlaceholderToken,
          errorMessage: `Type mismatch for type parameter "${forallParameter.label}":
Expected: ${typeToString(forallParameter.type)}
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
              isMutable: false,
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
        parameterType: forallParameter.type,
      });
    }
  }

  if (
    !functionType.variadicParameter &&
    argExprs.length > functionType.parameters.length
  ) {
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
Expected: ${functionType.parameters.length} arguments
Got:   ${argExprs.length} arguments`,
      });
    }
  }

  // Check if the parameters match the arguments
  let regularArgIndex = 0;
  for (
    regularArgIndex = 0;
    regularArgIndex < functionType.parameters.length;
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
      functionValue,
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

  // Synthesize the returnType if context.expectedType is giving
  // The context.expectedType is the expected function return type.
  // QUESTION: Should we run it after evaluating the normal arguments?
  // YES We should do it after evaluating the normal arguments
  // Otherwise it might cause the variable shadowing problem.
  // See example in compt_runtime.yo.
  if (context.expectedType) {
    const { expectedEnv } = synthesizeTypes(
      { type: functionType.return.type, env: calleeEnv },
      { type: context.expectedType.type, env: context.expectedType.env }
    );
    calleeEnv = expectedEnv;
    // env = givenEnv; // NOTE: No need to update `env` here
  }

  // Check if the implicit parameters are provided
  for (let i = 0; i < functionType.implicitParameters.length; i++) {
    const implicitParameter = functionType.implicitParameters[i]!;

    // Evaluate its type again
    const {
      parameterType: newImplicitParameterType,
      calleeEnv: nextCalleeEnv,
    } = evaluateFunctionParameterType({
      parameter: implicitParameter,
      calleeEnv,
      context: {
        ...context,
      },
      functionValue,
    });
    calleeEnv = nextCalleeEnv;
    let implicitParameterType = newImplicitParameterType;

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
            isMutable: implicitParameter.isMutable,
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

      // Evaluate the parameter type again
      const {
        parameterType: newImplicitParameterType,
        calleeEnv: nextCalleeEnv,
      } = evaluateFunctionParameterType({
        parameter: implicitParameter,
        calleeEnv,
        context: {
          ...context,
        },
        functionValue,
      });
      implicitParameterType = newImplicitParameterType;
      calleeEnv = nextCalleeEnv;

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

        // Check if type matches
        if (
          areTypesCompatible(
            { type: implicitParameterType, env: calleeEnv },
            { type: variable.type, env: callerEnv }
          )
        ) {
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
${implicitParameter.label ? `given(${implicitParameter.label}) :\n  ${typeToString(implicitParameterType)}` : `implicit ${typeToString(implicitParameterType)}`}`,
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

    // Check if it's from an implicit function call
    if (
      isFunctionType(implicitVariable.type) &&
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
          isMutable: implicitVariable.isMutable,
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
              isMutable: implicitVariable.isMutable,
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
            isMutable: implicitVariable.isMutable,
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
          isMutable: implicitVariable.isMutable,
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
            isMutable: implicitVariable.isMutable,
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
          isMutable: false,
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
          isMutable: functionType.variadicParameter.isMutable,
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

  // Evaluate the function return type again
  const evaluatedFunctionReturnExpr = context.evaluateExpression({
    expr: cloneExpr(functionType.return.expr),
    env: calleeEnv,
    context: { ...context },
  });

  const functionReturnTypeValue = evaluatedFunctionReturnExpr.$?.value;
  if (!isTypeValue(functionReturnTypeValue)) {
    throw formatErrorMessage({
      token: functionCalleeExpr?.token ?? PlaceholderToken,
      errorMessage: `Function body is not evaluated correctly. Expected to return a type.`,
    });
  }
  const returnType = functionReturnTypeValue.value;

  const pathCollection: PathCollection = [];
  if (context.borrowings.length !== initialBorrowings.length) {
    const newBorrowings = context.borrowings.slice(initialBorrowings.length);
    newBorrowings.forEach((borrowing) => {
      const pc = borrowing.pathCollection;
      pc.forEach((path) => {
        pathCollection.push(path);
      });
    });
  }

  const argValues_: ArgValues = {
    args: argValues,
    forallArgs: forallArgValues,
    implicitArgs: implicitArgValues,
    variadicArgs,
  };

  // Check if we need to evaluate the compt function call
  // such as the type function, macro function, or function that returns compt value.
  let returnValue: Value | undefined;
  if (functionType.return.isCompileTimeOnly) {
    if (isFunctionValue(functionValue)) {
      const { value: nextReturnValue, callerEnv: nextEnv } =
        evaluateComptFunctionCall({
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
      callerEnv = nextEnv;
    } else {
      returnValue = createUnknownValue(returnType);
    }
  }

  // Check if function has compile-time parameters and create specialized version if needed
  let specializedFunctionValue: FunctionValue | undefined;

  if (
    functionValue &&
    isFunctionValue(functionValue) && // functionValue might be UnknownValue, so this condition check is necessary
    isFunctionSpecializable(functionType)
  ) {
    specializedFunctionValue = createSpecializedFunctionInline({
      originalFunction: functionValue,
      functionType,
      argValues: argValues_,
      calleeEnv: calleeEnv,
      callerEnv: callerEnv,
      context,
    });
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
  };
}

/**
 * Create a specialized function inline within tryToCallFunctionWithArguments
 */
function createSpecializedFunctionInline({
  originalFunction,
  functionType,
  argValues,
  calleeEnv,
  callerEnv,
  context,
}: {
  originalFunction: FunctionValue;
  functionType: FunctionType;
  argValues: ArgValues;
  calleeEnv: Environment;
  callerEnv: Environment;
  context: EvaluatorContext;
}): FunctionValue {
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
  const specializedBody = context.evaluateExpression({
    expr: clonedBody,
    env: specializedEnv,
    context: {
      ...context,
      expectedType: undefined,
      isEvaluatingFunctionBody: {
        type: functionType,
        value: originalFunction,
        capturedVariables:
          functionType.closureKind !== undefined
            ? new Map<string, CapturedVariableInfo>()
            : undefined,
        evaluationEnv: specializedEnv,
      },
    },
  });
  if (!specializedBody.$) {
    throw formatErrorMessage({
      token: originalFunction.body.token,
      errorMessage: `Failed to evaluate function body for specialization.`,
    });
  }

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
      type: specializedBody.$.type,
    },
    parametersFrame: specializedEnv.frames[specializedEnv.frames.length - 1]!, // QUESTION: This could be wrong
    env: functionType.env,
    SelfType: functionType.SelfType,
    ModuleType: functionType.ModuleType,
    closureKind: functionType.closureKind, // Preserve closure property
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
