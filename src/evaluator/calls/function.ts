import { checkBorrowings } from "../../borrow";
import {
  addVariableToEnv,
  Environment,
  getMethodsByNameFromEnv,
  getVariablesFromEnv,
  getVariablesFromEnvByFilter,
  popEnvFrame,
  pushEnvFrame,
  updateExistingVariable,
  Variable,
} from "../../env";
import {
  formatErrorMessage,
  formatErrorMessages,
  MoParserError,
} from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  cloneExpr,
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  PathCollection,
} from "../../expr";
import { FunctionValue, SpecializedFunctionCache } from "../../function-value";
import { PlaceholderToken, stringIsOperator, TokenType } from "../../token";
import { TypeValue } from "../../type-value";
import {
  areTypesCompatible,
  createExprType,
  FunctionType,
  isArrayType,
  isEnumType,
  isExprListType,
  isFunctionSpecializable,
  isFunctionType,
  isModuleType,
  isStructType,
  isUnionType,
  Type,
  typeOfType,
  typeToString,
} from "../../types";
import {
  areValuesEqual,
  ArrayValue,
  createEnumValue,
  createStructValue,
  createTypeValue,
  createUnknownValue,
  isExprValue,
  isFunctionValue,
  isTupleValue,
  isTypeValue,
  Value,
  valueToString,
} from "../../value";
import {
  ArgValues,
  EvaluatorContext,
  FunctionCallResult,
  FunctionToCall,
  getArrayCallResult,
  getFunctionCallResult,
  getModuleTypeCallResult,
  getTypeCallResult,
} from "../context";
import { synthesizeTypes } from "../types/synthesizer";
import { evaluateAnonymousStructValue } from "../values/anonymous_struct";
import { tryToCallArrayWithArguments } from "./array";
import { evaluateComptFunctionCall } from "./compt_function";
import { tryToImplementFunctionByFunctionType } from "./function_type";
import {
  checkIfFunctionParameterMatchesArgument,
  evaluateFunctionParameterType,
} from "./helper";
import { tryToImplementModuleWithArgumentsByModuleType } from "./module_type";
import { tryToCallTypeWithArguments } from "./type";

/**
 * NOTE: This function will push new frame to the function env,
 * but will not pop frame.
 */
export function tryToCallFunctionWithArguments({
  functionValue,
  functionType,
  functionCallExpr,
  argExprs,
  callerEnv,
  context,
  isMethodCall,
}: {
  functionValue?: FunctionValue;
  functionType: FunctionType;
  functionCallExpr?: Expr;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
  isMethodCall: boolean;
}): FunctionCallResult {
  const initialBorrowings = [...context.borrowings];

  let forallArgsExpr: FuncCallExpr | undefined = undefined;
  let implicitArgExprs: Expr[] = [];

  const forallArgValues: Value[] = [];
  const argValues: (Value | undefined)[] = [];
  const implicitArgValues: (Value | undefined)[] = [];

  // Check if there is `forall(...)` argument zone.
  // If yes, then it should be the first argument
  //
  // Check if there is `implicit(...)` argument zone.
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
      exprIsFunctionCallOf(argExpr, BuiltinKeywords.implicit)
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

  for (let i = 0; i < functionType.typeParameters.length; i++) {
    // Add typeParameter to calleeEnv
    const typeParameter = functionType.typeParameters[i]!;
    let typeParameterVariable: Variable | undefined = undefined;
    // NOTE: No need to add typeParameter to env
    //       It will cause the variable shadowing problem.
    if (typeParameter.exprs.labelExpr && typeParameter.label) {
      // console.log("(12) addVariableToEnv");
      const { env: nextEnv, variable } = addVariableToEnv({
        env: calleeEnv,
        variable: {
          name: typeParameter.label,
          type: typeParameter.type,
          isMutable: false,
          isCompileTimeOnly: true,
          isImplicit: false,
          value: createUnknownValue(typeParameter.type, typeParameter.label),
          token: typeParameter.exprs.labelExpr.token,
          initializedAtToken: typeParameter.exprs.labelExpr.token, // Set as initialized
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
        if (typeParameter.label !== labelExpr.token.value) {
          throw formatErrorMessage({
            token: labelExpr.token,
            errorMessage: `Expected type parameter label "${typeParameter.label}", got "${labelExpr.token.value}".`,
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
        // Check if typeParameter has default value
        if (typeParameter.exprs.defaultValueExpr) {
          const evaluatedArgExpr = context.evaluateExpression({
            expr: cloneExpr(typeParameter.exprs.defaultValueExpr),
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
                functionCallExpr?.token ??
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
              functionCallExpr?.token ??
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
            expectedType: { type: typeParameter.type, env: calleeEnv },
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
          { type: typeParameter.type, env: calleeEnv },
          { type: typeValue.type, env: callerEnv }
        )
      ) {
        throw formatErrorMessage({
          token:
            forallArgExpr?.token ?? functionCallExpr?.token ?? PlaceholderToken,
          errorMessage: `Type mismatch for type parameter "${typeParameter.label}":
Expected: ${typeToString(typeParameter.type)}
Got:   ${typeToString(typeValue.type)}`,
        });
      }

      // Add the type to the env
      if (typeParameter.label) {
        // console.log("(13) addVariableToEnv");
        if (typeParameterVariable) {
          calleeEnv = updateExistingVariable(calleeEnv, typeParameterVariable, {
            ...typeParameterVariable,
            value: typeValue,
          });
        } else {
          const token =
            forallArgExpr?.token ?? functionCallExpr?.token ?? PlaceholderToken;
          const { env: nextEnv } = addVariableToEnv({
            env: calleeEnv,
            variable: {
              name: typeParameter.label,
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
      forallArgValues.push(typeValue);
    }
  }

  if (argExprs.length > functionType.parameters.length) {
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
        token: functionCallExpr?.token ?? PlaceholderToken,
        errorMessage: `Too many arguments for function call:
Expected: ${functionType.parameters.length} arguments
Got:   ${argExprs.length} arguments`,
      });
    }
  }

  // Check if the parameters match the arguments
  for (let i = 0; i < functionType.parameters.length; i++) {
    const parameter = functionType.parameters[i]!;
    const {
      calleeEnv: nextCalleeEnv,
      callerEnv: nextCallerEnv,
      context: nextContext,
      argValue,
    } = checkIfFunctionParameterMatchesArgument({
      functionValue,
      parameter,
      argExprs,
      argIndex: i,
      callerEnv,
      calleeEnv,
      context,
      isMethodCall,
    });
    calleeEnv = nextCalleeEnv;
    callerEnv = nextCallerEnv;
    context = nextContext;

    argValues.push(argValue);
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
    let implicitVariables = getVariablesFromEnvByFilter(
      callerEnv,
      (variable) => {
        if (
          !(
            Boolean(variable.isImplicit) &&
            Boolean(variable.isCompileTimeOnly) ===
              Boolean(implicitParameter.isCompileTimeOnly)
          )
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

            try {
              // FIXME: Prevent circular call
              const {
                returnType,
                calleeEnv: nextCalleeEnv,
                callerEnv: nextCallerEnv,
              } = tryToCallFunctionWithArguments({
                argExprs: [],
                callerEnv,
                functionType: funcType,
                functionValue: funcValue as FunctionValue | undefined,
                functionCallExpr: undefined, // FIXME: <- this is the wrong expr
                context: {
                  ...context,
                  expectedType: {
                    type: implicitParameterType,
                    env: calleeEnv,
                  },
                },
                isMethodCall: false,
              });
              return areTypesCompatible(
                { type: returnType, env: nextCallerEnv },
                { type: implicitParameterType, env: nextCalleeEnv }
              );
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
        token: functionCallExpr?.token ?? PlaceholderToken,
        errorMessage: `Implicit parameter is not provided. Expected:
${implicitParameter.label ? `implicit(${implicitParameter.label}) :\n  ${typeToString(implicitParameterType)}` : `implicit ${typeToString(implicitParameterType)}`}`,
      });
    }

    if (implicitVariables.length > 1) {
      throw formatErrorMessage({
        token: functionCallExpr?.token ?? PlaceholderToken,
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

    // console.log("(15) addVariableToEnv");
    const { env: nextEnv } = addVariableToEnv({
      env: calleeEnv,
      variable: {
        name: implicitParameter.label,
        type: implicitVariable.type,
        isMutable: implicitVariable.isMutable,
        isCompileTimeOnly: implicitVariable.isCompileTimeOnly,
        isImplicit: false,
        value: implicitVariable.value,
        token: functionCallExpr?.token ?? PlaceholderToken,
        initializedAtToken: functionCallExpr?.token ?? PlaceholderToken, // Set as initialized
        consumedAtToken: undefined, // Not consumed yet
      },
      skipCheckingFunctionOverloading: true,
    });
    calleeEnv = nextEnv;

    // Add the implicit variable value to the implicitArgValues
    implicitArgValues.push(implicitVariable.value);
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
      token: functionCallExpr?.token ?? PlaceholderToken,
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
  };

  // Check if we need to evaluate the compt function call
  // such as the type function, macro function, or function that returns compt value.
  let returnValue: Value | undefined = undefined;
  if (functionType.return.isCompileTimeOnly) {
    if (isFunctionValue(functionValue)) {
      const { value: nextReturnValue, callerEnv: nextEnv } =
        evaluateComptFunctionCall({
          functionCallExpr,
          functionType,
          functionValue,
          argValues: argValues_,
          callerEnv: callerEnv,
          calleeEnv: calleeEnv,
          context: {
            ...context,
          },
        });
      returnValue = nextReturnValue;
      callerEnv = nextEnv;
    } else {
      returnValue = createUnknownValue(returnType);
    }
  }

  // Check if function has compile-time parameters and create specialized version if needed
  let specializedFunctionValue: FunctionValue | undefined = undefined;

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
  };
}

export function evaluateFunctionCall({
  expr,
  env,
  context,
  givenFunc,
  forMacroExpansion,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
  givenFunc?: { type: Type; value: TypeValue | FunctionValue | undefined };
  forMacroExpansion?: boolean;
}): Expr {
  let func = expr.func;
  let args = expr.args;

  // For module method call
  let methodExpr: Expr | undefined = undefined;

  let functions: {
    type: Type;
    value?: Value;
    error?: Error | MoParserError;
  }[] = [];
  if (givenFunc) {
    functions = [givenFunc];
  } else {
    if (exprIsFunctionCall(func)) {
      const functionToCall = context.evaluateExpression({
        expr: func,
        env,
        context: {
          ...context,
        },
      });
      func = functionToCall;

      // Check borrowings
      // NOTE: This is necessary for function like array accessing element by index
      // for example:
      //   mut(xs) := [1, 2, 3];
      //   borrow &!(xs), xs_ref => {
      //     first_element := xs(0); // here `xs` is already borrowed, so we cannot use it.
      //   }
      checkBorrowings(context.borrowings, functionToCall);

      // Check if . property access for module method call
      if (!functionToCall.$?.type) {
        if (
          exprIsFunctionCall(functionToCall) &&
          exprIsFunctionCallOf(functionToCall, ".", 2)
        ) {
          const receiverArg = functionToCall.args[0]!;
          methodExpr = functionToCall.args[1]!;

          // The receiverArg should already be evaluated in the previous step
          // so it should have a type
          const receiverType = receiverArg.$?.type;
          if (!receiverType) {
            throw formatErrorMessage({
              token: receiverArg.token,
              errorMessage: `Expected to be evaluated.`,
            });
          }

          // The methodExpr should also be evaluated already
          // so it should have a type
          if (exprIsAtom(methodExpr)) {
            // 1.add(3);
            const methodName = methodExpr.token.value;
            // Get the method with the same name in the interface in the env
            const methods = getMethodsByNameFromEnv(
              env,
              methodName,
              receiverType
            );
            functions = methods.map((method) => ({
              type: method.type,
              value: method.value,
            }));
            // TODO: Autocase to reference/immutable reference
            args = [receiverArg, ...args];
          } else {
            // 1.(Add.add)(3);
            // Try to evaluate the methodExpr
            const nextExpr = context.evaluateExpression({
              expr: methodExpr,
              env,
              context: {
                ...context,
              },
            });
            if (nextExpr.$?.env) {
              env = nextExpr.$?.env;
            }
            methodExpr = nextExpr;

            const methodType = methodExpr.$?.type;
            const methodValue = methodExpr.$?.value;
            if (!methodType) {
              throw formatErrorMessage({
                token: methodExpr.token,
                errorMessage: `Expected to be a function.`,
              });
            }
            functions = [
              {
                type: methodType,
                value: methodValue,
              },
            ];
            // TODO: Autocase to reference/immutable reference
            args = [receiverArg, ...args];
          }
        } else {
          throw formatErrorMessage({
            token: func.token,
            errorMessage: `Expected type for function call, got ${exprToString(
              functionToCall
            )}`,
          });
        }
      } else {
        functions = [
          {
            type: functionToCall.$.type,
            value: functionToCall.$.value,
          },
        ];
      }
    } else {
      const functionName =
        func.token.type === TokenType.BacktickIdentifier
          ? func.token.value.slice(1, -1) // Convert `add` to add
          : func.token.value;

      // Check _ function
      if (functionName === "_") {
        const expectedType = context.expectedType;
        if (!expectedType) {
          // throw formatErrorMessage(
          //   func.token,
          //   `Failed to infer type for _ function`
          // );

          // Make it as an anonymous struct
          return evaluateAnonymousStructValue({
            expr,
            env,
            context,
          });
        }
        functions = [
          {
            type: typeOfType(expectedType.type),
            value: createTypeValue(expectedType.type),
          },
        ];

        // Add info to the func token
        func.$ = {
          env,
          type: functions[0]!.type,
          value: functions[0]!.value,
          isMutable: false,
          pathCollection: [],
        };
      }
      // Infix operator is taken as an method call
      else if (stringIsOperator(functionName) && expr.isInfix) {
        const firstArg = args[0];
        if (!firstArg) {
          throw formatErrorMessage({
            token: func.token,
            errorMessage: `Expected first argument for operator, got:\n${exprToString(func)}`,
          });
        }
        // Evaluate the first argument to get its type
        const evaluatedFirstArg = context.evaluateExpression({
          expr: firstArg,
          env,
          context: {
            ...context,
          },
        });
        const receiverType = evaluatedFirstArg.$?.type;
        if (!receiverType) {
          throw formatErrorMessage({
            token: firstArg.token,
            errorMessage: `Expected to be evaluated.`,
          });
        }
        const methodName = functionName;
        methodExpr = func;
        // Get the method with the same name in the interface in the env
        const moduleMethods = getMethodsByNameFromEnv(
          env,
          methodName,
          receiverType
        );
        functions = moduleMethods.map((method) => ({
          type: method.type,
          value: method.value,
        }));
        // No need to change the args
      }
      // Self function call
      else if (functionName === "Self" && context.SelfType) {
        const value = createTypeValue(context.SelfType);
        functions = [
          {
            type: value.type,
            value: value,
          },
        ];
      }
      // Normal function call
      else {
        const functionToCall = context.evaluateExpression({
          expr: func,
          env,
          context: {
            ...context,
          },
        });
        func = functionToCall;

        // Check borrowings
        // NOTE: This is necessary for function like array accessing element by index
        // for example:
        //   mut(xs) := [1, 2, 3];
        //   borrow &!(xs), xs_ref => {
        //     first_element := xs(0); // here `xs` is already borrowed, so we cannot use it.
        //   }
        checkBorrowings(context.borrowings, functionToCall);

        // Check if func is a module value,
        // If yes, then we extract the Self from it.
        if (isModuleType(functionToCall.$?.type)) {
          const moduleType = functionToCall.$.type;
          const SelfIndex = moduleType.elements.findIndex(
            (e) => e.label === "Self"
          );
          if (SelfIndex < 0) {
            throw formatErrorMessage({
              token: func.token,
              errorMessage: `Calling a module value which does not have "Self" element is not allowed.`,
            });
          }
          const SelfType = moduleType.elements[SelfIndex]!;
          if (SelfType.assignedValue) {
            const SelfValue = SelfType.assignedValue;
            if (isTupleValue(SelfValue)) {
              functions = SelfValue.elements.map((element) => {
                return {
                  type: element.type,
                  value: element,
                };
              });
            } else {
              functions = [
                {
                  type: SelfValue.type,
                  value: SelfValue,
                },
              ];
            }
          } else {
            throw formatErrorMessage({
              token: func.token,
              errorMessage: `Calling a module value whose "Self" element doesn't have assigned value is not allowed.`,
            });
          }
        } else {
          /**
           * functionVariables might be of FunctionType, StructType, UnionType, and EnumVariant
           */
          const functionVariables = getVariablesFromEnv(env, functionName);
          functions = functionVariables.map((variable) => ({
            type: variable.type,
            value: variable.value,
            isMutable: variable.isMutable,
          }));
        }
      }
    }
  }

  // Find the functions whose parameters match the arguments
  const functionsToCall: FunctionToCall[] = functions.map((functionToCall) => {
    if (isFunctionType(functionToCall.type)) {
      try {
        const result = tryToCallFunctionWithArguments({
          functionValue: functionToCall.value as FunctionValue | undefined,
          functionType: functionToCall.type,
          functionCallExpr: func,
          argExprs: args,
          callerEnv: env,
          context: { ...context },
          isMethodCall: Boolean(methodExpr),
        });
        return {
          ...functionToCall,
          result: {
            kind: "function",
            result,
          },
        };
      } catch (error) {
        return {
          ...functionToCall,
          result: {
            kind: "error",
            error: error,
          },
        };
      }
    } else {
      const value = functionToCall.value;

      // struct value
      if (isTypeValue(value) && isStructType(value.value)) {
        try {
          const result = tryToCallTypeWithArguments({
            memberElements: value.value.elements,
            functionCallExpr: func,
            argExprs: args,
            callerEnv: env,
            context: { ...context },
          });
          return {
            ...functionToCall,
            result: {
              kind: "type",
              result,
            },
          };
        } catch (error) {
          return {
            ...functionToCall,
            result: {
              kind: "error",
              error: error,
            },
          };
        }
      }
      // enum value
      else if (isTypeValue(value) && isEnumType(value.value)) {
        const enumType = value.value;
        const selectedVariant = enumType.variants.find(
          (variant) => variant.name === enumType.selectedVariantName
        );
        if (!selectedVariant) {
          return {
            ...functionToCall,
            result: {
              kind: "error",
              error: formatErrorMessage({
                token: expr.token,
                errorMessage: `Enum variant not selected for enum type`,
              }),
            },
          };
        } else {
          try {
            const result = tryToCallTypeWithArguments({
              memberElements: selectedVariant.elements || [],
              functionCallExpr: func,
              argExprs: args,
              callerEnv: env,
              context: { ...context },
            });
            return {
              ...functionToCall,
              result: {
                kind: "type",
                result,
              },
            };
          } catch (error) {
            return {
              ...functionToCall,
              result: {
                kind: "error",
                error: error,
              },
            };
          }
        }
      }
      // union value
      else if (isTypeValue(value) && isUnionType(value.value)) {
        try {
          const result = tryToCallTypeWithArguments({
            memberElements: value.value.elements,
            functionCallExpr: func,
            argExprs: args,
            callerEnv: env,
            context: { ...context },
            isUnionType: true,
          });
          return {
            ...functionToCall,
            result: {
              kind: "type",
              result,
            },
          };
        } catch (error) {
          return {
            ...functionToCall,
            result: {
              kind: "error",
              error: error,
            },
          };
        }
      }
      // module value
      else if (isTypeValue(value) && isModuleType(value.value)) {
        const moduleType = value.value;
        try {
          const result = tryToImplementModuleWithArgumentsByModuleType({
            moduleExpr: func,
            moduleType: moduleType,
            argExprs: args,
            callerEnv: env,
            context: { ...context },
          });
          return {
            ...functionToCall,
            result: {
              kind: "module-type",
              result,
            },
          };
        } catch (error) {
          return {
            ...functionToCall,
            result: {
              kind: "error",
              error: error,
            },
          };
        }
      }
      // function
      else if (isTypeValue(value) && isFunctionType(value.value)) {
        const functionType = value.value;
        try {
          tryToImplementFunctionByFunctionType({
            expr: expr,
            functionType: functionType,
            callerEnv: env,
            context: { ...context },
          });
          return {
            ...functionToCall,
            result: {
              kind: "function-type",
            },
          };
        } catch (error) {
          return {
            ...functionToCall,
            result: {
              kind: "error",
              error: error,
            },
          };
        }
      }
      // array
      else if (isArrayType(functionToCall.type)) {
        try {
          const result = tryToCallArrayWithArguments({
            expr,
            arrayType: functionToCall.type,
            arrayValue: functionToCall.value as ArrayValue | undefined,
            argExprs: args,
            callerEnv: env,
            context: { ...context },
          });
          return {
            ...functionToCall,
            result: {
              kind: "array",
              result,
            },
          };
        } catch (error) {
          return {
            ...functionToCall,
            result: {
              kind: "error",
              error: error,
            },
          };
        }
      } else {
        return {
          ...functionToCall,
          result: {
            kind: "error",
            error: formatErrorMessage({
              token: func.token,
              errorMessage: `Invalid function call on type:
${isTypeValue(value) ? typeToString(value.value) : typeToString(functionToCall.type)}`,
            }),
          },
        };
      }
    }
  });

  let functionsWithMatchingTypes = functionsToCall.filter(
    (functionToCall) => functionToCall.result.kind !== "error"
  );

  // Check if there is only one compt function call,
  // If yes, then we use that function.
  // Compt function call has higher priority than normal function call.
  // So this way we eagerly evaluate the function call that can be done at the compile-time.
  const comptFunctionCalls = functionsWithMatchingTypes.filter(
    (functionToCall) =>
      isFunctionType(functionToCall.type) &&
      functionToCall.type.return.isCompileTimeOnly // TODO: How about other type calls?
  );
  if (comptFunctionCalls.length === 1) {
    functionsWithMatchingTypes = comptFunctionCalls;
  }

  if (functionsWithMatchingTypes.length === 0) {
    if (
      functionsToCall.length === 1 &&
      functionsToCall[0]!.result.kind === "error"
    ) {
      const error = functionsToCall[0]!.result.error;
      if (error instanceof MoParserError) {
        throw formatErrorMessages({
          tokenAndErrorList: [
            {
              token: expr.token,
              errorMessage: `Failed to call the function:`,
            },
            {
              token: error.token,
              errorMessage: error.message,
            },
          ],
        });
      } else {
        throw formatErrorMessages({
          tokenAndErrorList: [
            {
              token: expr.token,
              errorMessage: `Failed to call the function:`,
            },
            {
              token: expr.token,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
          ],
        });
      }
    }

    throw formatErrorMessage({
      token: func.token,
      errorMessage: `No matching call found with arguments:
${exprToString(expr)}

${functionsToCall.length ? "Available functions:\n" : ""}${functionsToCall
        .map((func) => {
          const error =
            func.result.kind === "error" ? func.result.error : undefined;
          if (error) {
            const errorMessage = error.message;
            // Append 2 spaces ahead each line of the errorMessage
            const errorMessageWithIndent = errorMessage
              .split("\n")
              .map((line) => `  ${line}`)
              .join("\n");

            return `
- ${typeToString(func.type)}
${errorMessageWithIndent}`;
          } else {
            return `${typeToString(func.type)}`;
          }
        })
        .join("\n")}
`,
    });
  }
  if (functionsWithMatchingTypes.length > 1) {
    throw formatErrorMessage({
      token: func.token,
      errorMessage: `Ambiguous call with arguments:
${exprToString(expr)}

Found ${functionsWithMatchingTypes.length} matching calls:
${functionsWithMatchingTypes
  .map((func) => `${typeToString(func.type)}`)
  .join("\n")}
`,
    });
  }

  const functionToCall = functionsWithMatchingTypes[0]!; // Found the only one function to call

  // This function call is for macro expansion.
  // So we just return the expr we expanded.
  if (forMacroExpansion) {
    // It is macro function call
    if (
      isFunctionType(functionToCall.type) &&
      functionToCall.type.return.isUnquote
    ) {
      const { returnValue, callerEnv, pathCollection } =
        getFunctionCallResult(functionToCall);

      env = popEnvFrame(callerEnv);

      expr.$ = {
        env,
        type: createExprType(),
        value: returnValue,
        isMutable: false,
        pathCollection: pathCollection,
      };

      return expr;
    } else {
      throw formatErrorMessage({
        token: func.token,
        errorMessage: `Expected macro function call for macro_expand.`,
      });
    }
  }

  if (isFunctionType(functionToCall.type)) {
    const functionType = functionToCall.type;
    {
      // It's
      // - Function returns runtime value
      // - Function returns comptime value
      // For function returns comptime value, we can evaluate the function body.
      const {
        returnType,
        returnValue,
        callerEnv,
        // calleeEnv,
        // argValues,
        pathCollection,
        specializedFunctionValue,
      } = getFunctionCallResult(functionToCall);

      env = popEnvFrame(callerEnv);

      // Check if it's a macro function call,
      // if yes, then we continue to evaluate the returnValue which should be an Expr value.
      if (functionType.return.isUnquote) {
        if (isExprValue(returnValue)) {
          return context.evaluateExpression({
            expr: returnValue.value,
            env,
            context: {
              ...context,
            },
          });
        } else {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `Expected macro function to return an Expr value, got:\n${valueToString(
              returnValue
            )}`,
          });
        }
      }

      expr.$ = {
        env,
        type: returnType,
        value: returnValue,
        isMutable: false,
        pathCollection: pathCollection,
      };
      // Set temp variable which holds the result of the function call
      attachTempVariableToExpr(expr);

      // Attach necessary info to the func
      func.$ = {
        env,
        type: functionToCall.type,
        value: specializedFunctionValue || functionToCall.value,
        isMutable: false,
        pathCollection: [],
      };
      if (methodExpr) {
        methodExpr.$ = {
          env,
          type: functionToCall.type,
          value: specializedFunctionValue || functionToCall.value,
          isMutable: false,
          pathCollection: [],
        };
      }
    }
    return expr;
  } else {
    const value = functionToCall.value;
    // struct value
    if (isTypeValue(value) && isStructType(value.value)) {
      const structType = value.value;
      expr.$ = {
        env,
        type: structType,
        isMutable: false,
        pathCollection: [],
      };

      const {
        values: memberValues,
        pathCollection,
        callerEnv,
      } = getTypeCallResult(functionToCall);
      env = callerEnv;
      if (!memberValues) {
        throw formatErrorMessage({
          token: func.token,
          errorMessage: `Error evaluating struct call.`,
        });
      }
      const structValue = memberValues.some((value) => !value)
        ? undefined
        : createStructValue(structType, memberValues as Value[]);
      expr.$.value = structValue;
      expr.$.pathCollection = pathCollection;
      expr.$.env = env;

      // Attach necessary info to the func
      func.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // enum value
    else if (isTypeValue(value) && isEnumType(value.value)) {
      const enumType = value.value;
      expr.$ = {
        env,
        type: enumType,
        isMutable: false,
        pathCollection: [],
      };
      // FIXME: Support to set value for comptime
      const selectedVariant = enumType.variants.find(
        (variant) => variant.name === enumType.selectedVariantName
      );
      if (!selectedVariant) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Enum variant not selected for enum type`,
        });
      }
      const {
        values: memberValues,
        pathCollection,
        callerEnv,
      } = getTypeCallResult(functionToCall);
      env = callerEnv;

      if (!memberValues) {
        throw formatErrorMessage({
          token: func.token,
          errorMessage: `Error evaluating enum call.`,
        });
      }
      if (memberValues.every((v) => !!v)) {
        const enumValue = createEnumValue(
          enumType,
          selectedVariant.name,
          memberValues as Value[]
        );
        expr.$.value = enumValue;
      }
      expr.$.pathCollection = pathCollection;
      expr.$.env = env;

      // Attach necessary info to the func
      func.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // union value
    else if (isTypeValue(value) && isUnionType(value.value)) {
      const unionType = value.value;
      expr.$ = {
        env,
        type: unionType,
        isMutable: false,
        pathCollection: [],
      };
      const { pathCollection, callerEnv } = getTypeCallResult(functionToCall);
      env = callerEnv;
      expr.$.value = undefined;
      expr.$.pathCollection = pathCollection;
      expr.$.env = env;

      // Attach necessary info to the func
      func.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // module value
    else if (isTypeValue(value) && isModuleType(value.value)) {
      const { moduleValue, callerEnv } =
        getModuleTypeCallResult(functionToCall);
      env = callerEnv;

      expr.$ = {
        env,
        type: moduleValue.type,
        value: moduleValue,
        isMutable: false,
        pathCollection: [],
      };

      // Attach necessary info to the func
      func.$ = {
        env,
        type: value.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      return expr;
    }
    // function value
    else if (isTypeValue(value) && isFunctionType(value.value)) {
      // This should already be evaluated.
      /*
        if (!expr.$ || !expr.$.value) {
          throw formatErrorMessage(
            func.token,
            `Expected function value for function call, got:\n${exprToString(
              expr
            )}`
          );
        }
        */
      return expr;
    }
    // array
    else if (isArrayType(functionToCall.type)) {
      const arrayType = functionToCall.type;
      const { value } = getArrayCallResult(functionToCall);

      expr.$ = {
        env,
        type: arrayType.elementType,
        value: value,
        /**
         * NOTE: Here func is the array value itself.
         * We read the isMutable and pathCollection from it.
         * This is mainly used for array, for example:
         *   mut(xs) := [1, 2, 3];
         *   borrow &!(xs(0)), xs_ref => {
         *     //      ^ calling here, it is mutable.
         *   }
         */
        isMutable: Boolean(func.$?.isMutable),
        pathCollection: func.$?.pathCollection ?? [],
        /**
         * NOTE: We need to set isAccessingProperty to true here
         * to prevent getting an array element of Linear type.
         */
        isAccessingProperty: true,
      };

      // Attach necessary info to the func
      func.$ = {
        env,
        type: functionToCall.type,
        value: functionToCall.value,
        isMutable: Boolean(func.$?.isMutable),
        pathCollection: func.$?.pathCollection ?? [],
        isAccessingProperty: true,
      };
      return expr;
    }
  }

  throw formatErrorMessage({
    token: expr.token,
    errorMessage: `Function call is not implemented yet:
${exprToString(expr)}`,
  });
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

  // Add forall type arguments (always compile-time)
  if (argValues.forallArgs) {
    compileTimeArgValues.push(...argValues.forallArgs);
  }

  // Add regular compile-time parameters
  functionType.parameters.forEach((param, index) => {
    if (param.isCompileTimeOnly && index < argValues.args.length) {
      const arg = argValues.args[index]!;
      if (arg) {
        compileTimeArgValues.push(arg);
      }
    }
  });

  // Add implicit compile-time parameters
  if (argValues.implicitArgs) {
    functionType.implicitParameters.forEach((param, index) => {
      if (param.isCompileTimeOnly && index < argValues.implicitArgs!.length) {
        const implicitArg = argValues.implicitArgs![index];
        if (implicitArg) {
          compileTimeArgValues.push(implicitArg);
        }
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
  if (argValues.forallArgs) {
    compileTimeSignatureParts.push(
      ...argValues.forallArgs.map((arg) => valueToString(arg))
    );
  }

  // Include compile-time regular parameters
  functionType.parameters.forEach((param, index) => {
    if (param.isCompileTimeOnly && index < argValues.args.length) {
      const arg = argValues.args[index];
      if (arg) {
        compileTimeSignatureParts.push(valueToString(arg));
      } else {
        compileTimeSignatureParts.push("unknown");
      }
    }
  });

  // Include compile-time implicit parameters
  if (argValues.implicitArgs) {
    functionType.implicitParameters.forEach((param, index) => {
      if (param.isCompileTimeOnly && index < argValues.implicitArgs!.length) {
        const implicitArg = argValues.implicitArgs![index];
        if (implicitArg) {
          compileTimeSignatureParts.push(valueToString(implicitArg));
        } else {
          compileTimeSignatureParts.push("unknown");
        }
      }
    });
  }

  const compileTimeSignature = compileTimeSignatureParts.join("_");

  // Create a new specialized function value with the evaluated body
  const specializedFunction: FunctionValue = {
    ...originalFunction,
    body: specializedBody,
    // Use a signature-based ID for the specialized function
    funcId: compileTimeSignature
      ? `${originalFunction.funcId}_${compileTimeSignature}`
      : `${originalFunction.funcId}_specialized_${Date.now()}`,
    funcName: compileTimeSignature
      ? `${originalFunction.funcName}_${compileTimeSignature}`
      : `${originalFunction.funcName}_specialized_${Date.now()}`,
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
