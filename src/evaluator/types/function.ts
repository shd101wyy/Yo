import {
  addVariableToEnv,
  Environment,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  ClosureType,
  convertComptTypeToRuntimeType,
  createExprListType,
  createFunctionType,
  FunctionParameter,
  FunctionType,
  getFunctionParameterExprs,
  getFunctionParameterToken,
  isClosureType,
  isExprListType,
  isExprType,
  prohibitDynamicSizedType,
  Type,
  typeOfType,
  typeProhibitsComptModifier,
  typeRequiresComptModifier,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import {
  createTypeValue,
  createUnknownValue,
  isTypeValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { isValidVariableName } from "../utils";

/**
 * type:
 * i32 in (i32, ...)
 * (x: i32) in (x: i32, ...)
 * (mut(x): i32) in (mut(x): i32, ...)
 */
export function evaluateFunctionParameter({
  expr,
  expectedParameter,
  env,
  context,
}: {
  expr: Expr;
  expectedParameter?: FunctionParameter;
  env: Environment;
  context: EvaluatorContext;
}): { parameter: FunctionParameter; env: Environment } {
  let label: string | undefined = undefined;
  let isMutable: boolean = false;
  let isCompileTimeOnly: boolean = false;
  let isQuote: boolean = false;

  let lhsExpr: Expr | undefined = undefined;
  let rhsExpr: Expr | undefined = undefined;

  let parameterType: Type | undefined = undefined;
  let defaultValue: Value | undefined = undefined;

  let expr_: Expr = expr;
  let typeExpr: Expr | undefined = undefined;
  let labelExpr: Expr | undefined = undefined;
  let defaultValueExpr: Expr | undefined = undefined;

  if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, "=")) {
    throw formatErrorMessage({
      token: expr_.func.token,
      errorMessage: `Please use "?=" for default parameter value, not "=".`,
    });
  }

  // Check if there is defaultValue
  // eg:
  //   (x = 12)
  //   ((x: i32) ?= 13)
  if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, "?=", 2)) {
    if (expectedParameter) {
      throw formatErrorMessage({
        token: expr_.token,
        errorMessage: `Not allowed to define default parameter value for anonymous function implementation.`,
      });
    }

    rhsExpr = expr_.args[1]!;
    lhsExpr = expr_.args[0]!;
    defaultValueExpr = rhsExpr;
    expr_ = lhsExpr; // NOTE: Don't change the original `expr`
  }

  // Parse the lhs expr
  // eg:
  //   (x: i32)
  if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":", 2)) {
    if (expectedParameter) {
      throw formatErrorMessage({
        token: expr_.token,
        errorMessage: `Not allowed to define parameter type for anonymous function implementation.`,
      });
    }

    rhsExpr = expr_.args[1]!;
    lhsExpr = expr_.args[0]!;
    typeExpr = rhsExpr;
  } else {
    // eg:
    //   (i32)
    if (!defaultValueExpr) {
      typeExpr = expr_;
    }
    // eg:
    //   (x = 13)
    else {
      typeExpr = undefined;
      lhsExpr = expr_;
    }
  }

  if (lhsExpr) {
    if (
      exprIsFunctionCall(lhsExpr) &&
      exprIsFunctionCallOf(lhsExpr, BuiltinKeywords.compt)
    ) {
      isCompileTimeOnly = true;
      if (lhsExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `Expected one argument for "compt" , got ${lhsExpr.args.length}`,
        });
      }
      lhsExpr = lhsExpr.args[0]!;
    }

    if (
      exprIsFunctionCall(lhsExpr) &&
      exprIsFunctionCallOf(lhsExpr, BuiltinKeywords.mut)
    ) {
      isMutable = true;
      if (lhsExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `Expected one argument for "mut" (or "!"), got ${lhsExpr.args.length}`,
        });
      }
      lhsExpr = lhsExpr.args[0]!;
    }

    if (
      exprIsFunctionCall(lhsExpr) &&
      exprIsFunctionCallOf(lhsExpr, BuiltinKeywords.quote)
    ) {
      isQuote = true;
      if (lhsExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `Expected one argument for "quote" (or ":"), got ${lhsExpr.args.length}`,
        });
      }

      if (isCompileTimeOnly) {
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `Cannot use "compt"  with "quote" (or ":"). "quote" parameters means compile-time only, so "compt" is redundant.`,
        });
      }
      isCompileTimeOnly = true;

      lhsExpr = lhsExpr.args[0]!;
    }

    if (!exprIsAtom(lhsExpr) || !isValidVariableName(lhsExpr)) {
      throw formatErrorMessage({
        token: lhsExpr.token,
        errorMessage: `Expected identifier for parameter label, got ${exprToString(
          lhsExpr
        )}`,
      });
    }
    label = lhsExpr.token.value;
    labelExpr = lhsExpr;
  }

  if (!lhsExpr && expectedParameter) {
    // ^ This is for anonymous function implementation
    // where the parameter type is given
    // such as:
    // fn(a, b) -> a + b;
    parameterType = expectedParameter.type;

    lhsExpr = expr; // Use the original expr

    if (!exprIsAtom(lhsExpr) && !isValidVariableName(lhsExpr)) {
      throw formatErrorMessage({
        token: lhsExpr.token,
        errorMessage: `Expected identifier for parameter label, got ${exprToString(
          lhsExpr
        )}`,
      });
    }
    label = lhsExpr.token.value;
    labelExpr = lhsExpr;
  } else {
    // Evaluate the typeExpr if exists
    if (typeExpr) {
      // Parse the rhs expr which should be a type
      const evaluatedRhs = context.evaluateExpression({
        expr: typeExpr,
        env,
        context: { ...context },
      });
      if (!evaluatedRhs.$) {
        throw formatErrorMessage({
          token: typeExpr.token,
          errorMessage: `Failed to evaluate type expression: ${exprToString(typeExpr)}`,
        });
      }
      env = evaluatedRhs.$.env;

      // Expected the evaluatedRhs to be a type
      const typeValue = evaluatedRhs.$.value;
      if (!isTypeValue(typeValue)) {
        throw formatErrorMessage({
          token: typeExpr.token,
          errorMessage: `Expected type for function parameter, got ${exprToString(
            typeExpr
          )}`,
        });
      }
      parameterType = typeValue.value;
    }

    // Evaluate the defaultValueExpr if exists
    if (defaultValueExpr) {
      const evaluatedDefaultValue = context.evaluateExpression({
        expr: defaultValueExpr,
        env,
        context: {
          ...context,
        },
      });
      if (evaluatedDefaultValue.$?.env) {
        env = evaluatedDefaultValue.$?.env;
      }

      // Check the compile-time known value which has to exist
      defaultValue = evaluatedDefaultValue.$?.value;
      if (!defaultValue) {
        throw formatErrorMessage({
          token: defaultValueExpr.token,
          errorMessage: `Expected a compile-time known value for default parameter, got ${exprToString(
            defaultValueExpr
          )}`,
        });
      }

      if (!parameterType) {
        parameterType = defaultValue.type;
      } else {
        // Check if the default value type is compatible with the parameter type
        if (
          !areTypesCompatible(
            { type: parameterType, env },
            { type: defaultValue.type, env }
          )
        ) {
          throw formatErrorMessage({
            token: defaultValueExpr.token,
            errorMessage: `Incompatible default value type:
- Expected: ${typeToString(parameterType)}
- Got     : ${typeToString(defaultValue.type)}`,
          });
        }
      }
    }

    // Check the parameterType
    if (!parameterType) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected type for function parameter}`,
      });
    }
    if (typeRequiresComptModifier(parameterType) && !isCompileTimeOnly) {
      // Try converting to runtime type first
      parameterType = convertComptTypeToRuntimeType(parameterType);

      // If it still requires compt modifier,
      // then throw an error
      if (typeRequiresComptModifier(parameterType)) {
        throw formatErrorMessage({
          token: lhsExpr?.token ?? expr.token,
          errorMessage: `Expected a "compt" for parameter to be compile-time only. Given type:
${typeToString(parameterType)}`,
        });
      }
    }
    if (isCompileTimeOnly && typeProhibitsComptModifier(parameterType)) {
      throw formatErrorMessage({
        token: lhsExpr?.token ?? expr.token,
        errorMessage: `Unexpected "compt" for parameter of type ${typeToString(
          parameterType
        )} which can only be used at runtime.`,
      });
    }
  }

  // If it's isQuote, then it has to be Expr type or ExprList type
  if (isQuote && !isExprType(parameterType) && !isExprListType(parameterType)) {
    throw formatErrorMessage({
      token: lhsExpr?.token ?? expr.token,
      errorMessage: `Expected Expr or ExprList type for "quote" (or ":") parameter, got ${typeToString(parameterType)}`,
    });
  }

  /*
  // We disallow default value for quote parameters
  if (isQuote && defaultValueExpr) {
    throw formatErrorMessage({
      token: defaultValueExpr.token,
      errorMessage: `"quote" (or ":") parameter cannot have default value, got ${exprToString(
        defaultValueExpr
      )}`,
    });
  }
    */

  // We require to have label for function parameters
  if (!label) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected a label for function parameter, got ${exprToString(expr)}`,
    });
    // label = generateNewTempVariableName(this.modulePath);
  }

  const value = isCompileTimeOnly
    ? createUnknownValue(parameterType, label)
    : undefined;

  // Prohibit dynamic sized type
  prohibitDynamicSizedType(parameterType, typeExpr?.token ?? expr.token);

  // Add the parameter to the env
  // console.log("(9) addVariableToEnv");
  const { env: nextEnv } = addVariableToEnv({
    env,
    variable: {
      name: label,
      type: parameterType,
      isMutable: isMutable,
      isCompileTimeOnly: isCompileTimeOnly,
      isImplicit: false,
      value:
        // defaultValue ?? // NOTE: No need to use the default value here.
        isCompileTimeOnly
          ? createUnknownValue(parameterType, label)
          : undefined,
      token: lhsExpr?.token ?? expr.token,
      initializedAtToken: lhsExpr?.token ?? expr.token, // Set as initialized
      consumedAtToken: undefined, // Not consumed yet
    },
    skipCheckingFunctionOverloading: true,
  });
  env = nextEnv;

  if (lhsExpr) {
    lhsExpr.$ = {
      env,
      type: parameterType,
      value: value,
      isMutable,
      pathCollection: [],
    };
  }

  if (lhsExpr !== expr && typeExpr !== expr) {
    expr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      isMutable: false,
      pathCollection: [],
    };
  }

  // Validate closure mutability requirements
  if (isClosureType(parameterType)) {
    const closureType = parameterType as ClosureType;
    if (closureType.callType.closureKind === "FnMut" && !isMutable) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `FnMut closure parameters must be mutable. 
Use: mut(${label || "param"}) : ${typeToString(parameterType)}
Instead of: ${label || "param"} : ${typeToString(parameterType)}

FnMut closures can mutate their captured variables, so the closure parameter itself must be mutable.`,
      });
    }
  }

  return {
    parameter: {
      label: label,
      type: parameterType,
      exprs: getFunctionParameterExprs({
        expr,
        labelExpr,
        typeExpr,
        defaultValueExpr,
      }),
      isMutable,
      isCompileTimeOnly,
      isQuote,
    },
    env,
  };
}

/**
 * NOTE: Calling this function will increase the env frame.
 */
export function evaluateFunctionParameters({
  parameterExprs,
  expectedFunctionType,
  env,
  context,
}: {
  parameterExprs: Expr[];
  expectedFunctionType?: FunctionType;
  env: Environment;
  context: EvaluatorContext;
}): {
  parameters: FunctionParameter[];
  forallParameters: FunctionParameter[];
  implicitParameters: FunctionParameter[];
  variadicParameter?: FunctionParameter;
  env: Environment;
} {
  env = pushEnvFrame(env);

  const parameters: FunctionParameter[] = [];
  let forallParameters: FunctionParameter[] = [];
  let implicitParameters: FunctionParameter[] = [];
  let variadicParameter: FunctionParameter | undefined = undefined;

  let findTypeParameters = false;
  let findImplicitParameters = false;
  let findVariadicParameter = false;

  for (let i = 0; i < parameterExprs.length; i++) {
    const parameterExpr = parameterExprs[i]!;

    // Check if it's the type parameters
    if (
      exprIsFunctionCall(parameterExpr) &&
      exprIsFunctionCallOf(parameterExpr, BuiltinKeywords.forall)
    ) {
      findTypeParameters = true;

      if (i !== 0) {
        throw formatErrorMessage({
          token: parameterExpr.token,
          errorMessage: `Expected type parameters to be the first argument, got ${i + 1}`,
        });
      }
      const typeParameterExprs = parameterExpr.args;

      // Check if enough type parameters are provided
      // given the expected function type
      if (
        expectedFunctionType &&
        expectedFunctionType.forallParameters.length !==
          typeParameterExprs.length
      ) {
        throw formatErrorMessage({
          token: parameterExpr.token,
          errorMessage: `Expected ${expectedFunctionType.forallParameters.length} type parameters, got ${typeParameterExprs.length}`,
        });
      }

      for (let j = 0; j < typeParameterExprs.length; j++) {
        const typeParameterExpr = typeParameterExprs[j]!;
        const { parameter, env: nextEnv } = evaluateFunctionParameter({
          expr: typeParameterExpr,
          env,
          expectedParameter: expectedFunctionType?.forallParameters?.[j],
          context: {
            ...context,
          },
        });

        // Check if there is duplicate labels
        const duplicateLabel = forallParameters.find(
          (element) => element.label === parameter.label
        );
        if (duplicateLabel) {
          throw formatErrorMessage({
            token: typeParameterExpr.token,
            errorMessage: `Duplicate label "${parameter.label}" in type parameter`,
          });
        }

        // Require parameter to be compile-time only
        if (!parameter.isCompileTimeOnly) {
          throw formatErrorMessage({
            token: parameter.exprs.labelExpr?.token ?? typeParameterExpr.token,
            errorMessage: `Expected type parameter to be compile-time only, got ${exprToString(
              typeParameterExpr
            )}`,
          });
        }

        forallParameters.push(parameter);
        env = nextEnv;
      }
    }
    // Check if it's the implicit parameters
    else if (
      exprIsFunctionCall(parameterExpr) &&
      exprIsFunctionCallOf(parameterExpr, BuiltinKeywords.using)
    ) {
      findImplicitParameters = true;

      if (i !== parameterExprs.length - 1) {
        throw formatErrorMessage({
          token: parameterExpr.token,
          errorMessage: `Expected implicit parameters to be the last argument, got ${i + 1}`,
        });
      }

      const implicitParameterExprs = parameterExpr.args;

      // Check if enough implicit parameters are provided
      // given the expected function type
      if (
        expectedFunctionType &&
        expectedFunctionType.implicitParameters.length !==
          implicitParameterExprs.length
      ) {
        throw formatErrorMessage({
          token: parameterExpr.token,
          errorMessage: `Expected ${expectedFunctionType.implicitParameters.length} implicit parameters, got ${implicitParameterExprs.length}`,
        });
      }

      for (let j = 0; j < implicitParameterExprs.length; j++) {
        const implicitParameterExpr = implicitParameterExprs[j]!;
        const { parameter, env: nextEnv } = evaluateFunctionParameter({
          expr: implicitParameterExpr,
          env,
          expectedParameter: expectedFunctionType?.implicitParameters?.[j],
          context: {
            ...context,
          },
        });

        // Implicit parameter cannot have default value
        if (parameter.exprs.defaultValueExpr) {
          throw formatErrorMessage({
            token: implicitParameterExpr.token,
            errorMessage: `Implicit parameter cannot have default value, got ${exprToString(
              implicitParameterExpr
            )}`,
          });
        }

        // Check if there is duplicate labels
        const duplicateLabel = implicitParameters.find(
          (element) => element.label === parameter.label
        );
        if (duplicateLabel) {
          throw formatErrorMessage({
            token: implicitParameterExpr.token,
            errorMessage: `Duplicate label "${parameter.label}" in implicit parameter`,
          });
        }

        // If parameter is compile-time only, then
        // require there is no runtime implicitParameters before it
        if (parameter.isCompileTimeOnly) {
          const runtimeImplicitParameters = implicitParameters.filter(
            (p) => !p.isCompileTimeOnly
          );
          if (runtimeImplicitParameters.length > 0) {
            throw formatErrorMessage({
              token: implicitParameterExpr.token,
              errorMessage: `Compile-time parameters must appear first in the implicit parameter list.`,
            });
          }
        }

        implicitParameters.push(parameter);
        env = nextEnv;
      }
    }
    // Check if it's the variadic parameter
    else if (
      (exprIsAtom(parameterExpr) && exprIsAtomOf(parameterExpr, "...")) ||
      (exprIsFunctionCall(parameterExpr) &&
        exprIsFunctionCallOf(parameterExpr, "..."))
    ) {
      findVariadicParameter = true;

      // Get the variadic parameter name;
      let isCompileTimeOnly = false;
      let isQuote = false;
      let parameterName: string = "...";
      let labelExpr: Expr = parameterExpr;

      let parameterType: Type = VUnit.type; // Default type is VUnit
      if (exprIsFunctionCall(parameterExpr)) {
        const argExpr = parameterExpr.args[0]!;
        if (argExpr) {
          if (
            exprIsFunctionCall(argExpr) &&
            exprIsFunctionCallOf(argExpr, BuiltinKeywords.compt)
          ) {
            isCompileTimeOnly = true;
            if (argExpr.args.length !== 1) {
              throw formatErrorMessage({
                token: argExpr.token,
                errorMessage: `Expected one argument for "compt" , got ${argExpr.args.length}`,
              });
            }
            labelExpr = argExpr.args[0]!;
            parameterName = argExpr.args[0]!.token.value;

            // TODO: Set the parameterType to VaList
            parameterType = VUnit.type;

            throw formatErrorMessage({
              token: argExpr.token,
              errorMessage: `...(compt(param_name)) is not supported yet.`,
            });
          }
          // macro
          // we will use the ExprList as the type
          else if (
            exprIsFunctionCall(argExpr) &&
            exprIsFunctionCallOf(argExpr, BuiltinKeywords.quote)
          ) {
            isCompileTimeOnly = true;
            isQuote = true;
            if (argExpr.args.length !== 1) {
              throw formatErrorMessage({
                token: argExpr.token,
                errorMessage: `Expected one argument for "quote" (or ":"), got ${argExpr.args.length}`,
              });
            }
            labelExpr = argExpr.args[0]!;
            parameterName = argExpr.args[0]!.token.value;
            parameterType = createExprListType();
          } else {
            if (!isValidVariableName(argExpr)) {
              throw formatErrorMessage({
                token: argExpr.token,
                errorMessage: `Expected a valid variable name for variadic parameter, got ${exprToString(
                  argExpr
                )}`,
              });
            }
            labelExpr = argExpr;
            parameterName = argExpr.token.value;

            // TODO: Set the parameterType to VaList
            parameterType = VUnit.type;

            throw formatErrorMessage({
              token: argExpr.token,
              errorMessage: `...(param_name) is not supported yet.`,
            });
          }
        } else {
          throw formatErrorMessage({
            token: parameterExpr.token,
            errorMessage: `Expected a name for variadic parameter, got ${exprToString(
              parameterExpr
            )}`,
          });
        }
      } else {
        // Only has "..."
        parameterType = VUnit.type; // Default type is VUnit
      }

      // Create the parameter object
      variadicParameter = {
        exprs: {
          expr: parameterExpr,
          labelExpr,
        },
        isCompileTimeOnly,
        isMutable: false,
        isQuote,
        label: parameterName,
        type: parameterType,
      };

      if (parameterName !== "...") {
        // Add the parameter to the environment
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: parameterName,
            type: parameterType,
            isMutable: false,
            isCompileTimeOnly: variadicParameter.isCompileTimeOnly,
            isImplicit: false,
            value: isCompileTimeOnly
              ? createUnknownValue(parameterType, parameterName)
              : undefined,
            token: labelExpr.token,
            initializedAtToken: labelExpr.token, // Set as initialized
            consumedAtToken: undefined, // Not consumed yet
          },
        });
        env = nextEnv;

        // Add the information to the labelExpr
        labelExpr.$ = {
          env,
          type: parameterType,
          value: isCompileTimeOnly
            ? createUnknownValue(parameterType, parameterName)
            : undefined,
          isMutable: false,
          pathCollection: [],
        };
      }
    }
    // Normal function parameters
    else {
      if (findVariadicParameter) {
        throw formatErrorMessage({
          token: parameterExpr.token,
          errorMessage: `Expected variadic parameter to be the last parameter before the normal parameters.`,
        });
      }

      const { parameter, env: nextEnv } = evaluateFunctionParameter({
        expr: parameterExpr,
        expectedParameter: expectedFunctionType?.parameters?.[i],
        env,
        context: {
          ...context,
        },
      });

      // Check if there is duplicate labels
      const duplicateLabel = parameters.find(
        (element) => element.label === parameter.label
      );
      if (duplicateLabel) {
        throw formatErrorMessage({
          token: exprIsFunctionCall(parameterExpr)
            ? (parameterExpr.args[0]?.token ?? parameterExpr.token)
            : parameterExpr.token,
          errorMessage: `Duplicate label "${parameter.label}" in function parameter`,
        });
      }

      // If parameter is compile-time only, then
      // require there is no runtime parameters before it
      /*
      if (parameter.isCompileTimeOnly) {
        const runtimeParameters = parameters.filter(
          (p) => !p.isCompileTimeOnly
        );
        if (runtimeParameters.length > 0) {
          throw formatErrorMessage({
            token: parameterExpr.token,
            errorMessage: `Compile-time parameters must appear first in the parameter list.`,
          });
        }
      }
      */

      parameters.push(parameter);
      env = nextEnv;
    }
  }

  // Check if the parameters has ExprList type
  // If yes then it must be the last parameter
  parameters.forEach((parameter, index) => {
    if (parameter.isQuote && isExprListType(parameter.type)) {
      if (index !== parameters.length - 1) {
        throw formatErrorMessage({
          token: parameter.exprs.expr.token,
          errorMessage: `Expected ExprList type to be the last parameter.`,
        });
      }
    }
  });

  if (!findTypeParameters && expectedFunctionType?.forallParameters) {
    forallParameters = [...expectedFunctionType.forallParameters];
  }
  if (!findImplicitParameters && expectedFunctionType?.implicitParameters) {
    implicitParameters = [...expectedFunctionType.implicitParameters];
  }

  return {
    parameters,
    forallParameters,
    implicitParameters,
    variadicParameter,
    env,
  };
}

/**
 * Evaluate the function type:
 *
 * - fn(x : i32) -> i32;     // regular function type.
 * - fn(x : i32) => i32;     // FnOnce with `CaptureType` as SomeType.
 * - FnOnce(x : i32) -> i32; // FnOnce. Same as above.
 * - FnMut(x : i32) -> i32;  // FnMut.
 * - Fn(x : i32) -> i32;     // Fn.
 */
export function evaluateFunctionType({
  expr,
  env,
  context,
  closureKind,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
  closureKind?: "Fn" | "FnMut" | "FnOnce";
}): FuncCallExpr {
  // For closure types (Fn, FnMut, FnOnce), we expect -> operator
  // For regular functions, we expect -> operator
  const expectedOperator = "->";

  if (!exprIsFunctionCallOf(expr, expectedOperator, 2)) {
    const typeDescription = closureKind || "function";
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ${expectedOperator} for ${typeDescription} type, got:\n${exprToString(expr)}`,
    });
  }

  const argListExpr = expr.args[0]!;
  const returnExpr = expr.args[1]!;
  let isEffect = false;

  // Handle different forms of parameter lists
  let argList: Expr[] = [];

  // For closure types (Fn, FnMut, FnOnce), the argListExpr is the closure call itself
  // e.g., for "FnOnce(i32) -> i32", argListExpr is "FnOnce(i32)"
  if (closureKind && exprIsFunctionCall(argListExpr)) {
    // Extract arguments from the closure type call
    if (exprIsFunctionCallOf(argListExpr, closureKind)) {
      argList = argListExpr.args;
    } else {
      throw formatErrorMessage({
        token: argListExpr.token,
        errorMessage: `Expected ${closureKind} for closure type, got:\n${exprToString(argListExpr)}`,
      });
    }
  } else if (
    exprIsFunctionCall(argListExpr) &&
    (exprIsFunctionCallOf(argListExpr, BuiltinKeywords.fn) ||
      exprIsFunctionCallOf(argListExpr, BuiltinKeywords.eff))
  ) {
    argList = argListExpr.args;
    isEffect = exprIsFunctionCallOf(argListExpr, BuiltinKeywords.eff);
  } else {
    throw formatErrorMessage({
      token: argListExpr.token,
      errorMessage: `Expected a "fn" call for parameter list, got:\n${exprToString(argListExpr)}`,
    });
  }

  // Evaluate the parameter list
  const {
    parameters,
    forallParameters,
    implicitParameters,
    variadicParameter,
    env: nextEnv,
  } = evaluateFunctionParameters({
    parameterExprs: argList,
    env,
    context: {
      ...context,
    },
  });
  env = nextEnv;

  /// Check if the function is returning compile-time only value.
  let returnLabel: string | undefined = undefined;
  let isReturnTypeCompileTimeOnly = false;
  let isReturnTypeUnquote = false;
  let returnTypeExpr: Expr = returnExpr;
  /// has label
  /// -> (ret : i32)
  /// -> (compt(ret) : i32)
  /// -> (unquote(ret) : Expr)
  if (
    exprIsFunctionCall(returnExpr) &&
    exprIsFunctionCallOf(returnExpr, ":", 2)
  ) {
    let returnLabelExpr = returnExpr.args[0]!;
    returnTypeExpr = returnExpr.args[1]!;

    if (
      exprIsFunctionCall(returnLabelExpr) &&
      exprIsFunctionCallOf(returnLabelExpr, BuiltinKeywords.compt)
    ) {
      isReturnTypeCompileTimeOnly = true;
      if (returnLabelExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: returnLabelExpr.token,
          errorMessage: `Expected one argument for "compt" , got ${returnLabelExpr.args.length}`,
        });
      }
      returnLabelExpr = returnLabelExpr.args[0]!;
    }
    if (
      exprIsFunctionCall(returnLabelExpr) &&
      exprIsFunctionCallOf(returnLabelExpr, BuiltinKeywords.unquote)
    ) {
      isReturnTypeUnquote = true;
      if (returnLabelExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: returnLabelExpr.token,
          errorMessage: `Expected one argument for "unquote", got ${returnLabelExpr.args.length}`,
        });
      }
      if (isReturnTypeCompileTimeOnly) {
        throw formatErrorMessage({
          token: returnLabelExpr.token,
          errorMessage: `Cannot use "compt"  with "unquote". "unquote" return type means compile-time only, so "compt" is redundant.`,
        });
      }
      isReturnTypeCompileTimeOnly = true;

      returnLabelExpr = returnLabelExpr.args[0]!;
    }
    if (
      exprIsFunctionCall(returnLabelExpr) &&
      exprIsFunctionCallOf(returnLabelExpr, BuiltinKeywords.quote)
    ) {
      throw formatErrorMessage({
        token: returnLabelExpr.token,
        errorMessage: `To define a macro function, please use "unquote" for the return type, not "quote".`,
      });
    }
    if (!isValidVariableName(returnLabelExpr)) {
      throw formatErrorMessage({
        token: returnLabelExpr.token,
        errorMessage: `Expected a valid variable name for return label, got ${exprToString(
          returnLabelExpr
        )}`,
      });
    }
    returnLabel = returnLabelExpr.token.value;
  }
  /// has no label
  /// -> i32
  /// -> compt(i32)
  /// -> unquote(Expr)
  else {
    if (
      exprIsFunctionCall(returnTypeExpr) &&
      exprIsFunctionCallOf(returnTypeExpr, BuiltinKeywords.compt)
    ) {
      isReturnTypeCompileTimeOnly = true;
      if (returnTypeExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: returnTypeExpr.token,
          errorMessage: `Expected one argument for "compt" , got ${returnTypeExpr.args.length}`,
        });
      }
      returnTypeExpr = returnTypeExpr.args[0]!;
    }
    if (
      exprIsFunctionCall(returnTypeExpr) &&
      exprIsFunctionCallOf(returnTypeExpr, BuiltinKeywords.unquote)
    ) {
      isReturnTypeUnquote = true;
      if (returnTypeExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: returnTypeExpr.token,
          errorMessage: `Expected one argument for "unquote", got ${returnTypeExpr.args.length}`,
        });
      }
      if (isReturnTypeCompileTimeOnly) {
        throw formatErrorMessage({
          token: returnTypeExpr.token,
          errorMessage: `Cannot use "compt"  with "unquote". "unquote" return type means compile-time only, so "compt" is redundant.`,
        });
      }
      isReturnTypeCompileTimeOnly = true;

      returnTypeExpr = returnTypeExpr.args[0]!;
    }
    if (
      exprIsFunctionCall(returnTypeExpr) &&
      exprIsFunctionCallOf(returnTypeExpr, BuiltinKeywords.quote)
    ) {
      throw formatErrorMessage({
        token: returnTypeExpr.token,
        errorMessage: `To define a macro function, please use "unquote" for the return type, not "quote".`,
      });
    }
  }

  // Evaluate the return type expression
  const evaluatedReturnType = context.evaluateExpression({
    expr: returnTypeExpr,
    env,
    context: { ...context },
  });

  // Check that the return type is indeed a type
  if (!isTypeValue(evaluatedReturnType.$?.value)) {
    throw formatErrorMessage({
      token: returnTypeExpr.token,
      errorMessage: `Expected a type for function return type, got:\n${exprToString(
        returnTypeExpr
      )}`,
    });
  }

  let returnType = evaluatedReturnType.$?.value.value;
  if (typeRequiresComptModifier(returnType) && !isReturnTypeCompileTimeOnly) {
    // Try converting to runtime type first
    returnType = convertComptTypeToRuntimeType(returnType);
    // If it still requires compt modifier,
    // then throw an error
    if (typeRequiresComptModifier(returnType)) {
      throw formatErrorMessage({
        token: returnTypeExpr.token,
        errorMessage: `Expected a "compt"  for return type, like:\n
compt(${exprToString(returnTypeExpr)})

Given type:
${typeToString(returnType)}`,
      });
    }
  }

  // Prohibit the return type to be dynamic sized type
  prohibitDynamicSizedType(returnType, returnTypeExpr.token);

  if (isReturnTypeCompileTimeOnly && typeProhibitsComptModifier(returnType)) {
    throw formatErrorMessage({
      token: returnTypeExpr.token,
      errorMessage: `Unexpected "compt"  for return type of ${typeToString(
        returnType
      )} which can only be used at runtime.`,
    });
  }

  // If the returnType is compile time only, then
  // we need to make sure all the parameters are compile time only
  if (isReturnTypeCompileTimeOnly) {
    for (const parameter of parameters) {
      if (!parameter.isCompileTimeOnly) {
        throw formatErrorMessage({
          token: getFunctionParameterToken(parameter),
          errorMessage: `Expected all parameters to be compile time only given the return type is compile time only.`,
        });
      }
    }

    // Check if all implicitParameters are compile time only
    for (const parameter of implicitParameters) {
      if (!parameter.isCompileTimeOnly) {
        throw formatErrorMessage({
          token: getFunctionParameterToken(parameter),
          errorMessage: `Expected all implicit parameters to be compile time only given the return type is compile time only.`,
        });
      }
    }
  }

  // If the returnType is unquote, then
  // we need to make sure it's returning an Expr type
  if (isReturnTypeUnquote && !isExprType(returnType)) {
    throw formatErrorMessage({
      token: returnTypeExpr.token,
      errorMessage: `Expected Expr type for "unquote" return type, got ${typeToString(
        returnType
      )}`,
    });
  }

  // Create the function type
  const functionType = createFunctionType({
    parameters,
    forallParameters,
    implicitParameters,
    variadicParameter,
    return_: {
      type: returnType,
      expr: returnTypeExpr,
      isCompileTimeOnly: isReturnTypeCompileTimeOnly,
      isUnquote: isReturnTypeUnquote,
      label: returnLabel,
    },
    env: popEnvFrame(env, true),
    parametersFrame: env.frames[env.frames.length - 1]!,
    SelfType: context.SelfType,
    ModuleType: context.ModuleType,
    closureKind: closureKind, // Use the provided closure kind
    isEffect,
  });

  // Pop the environment frame
  env = popEnvFrame(env, true);

  // Set the type and value of the expression
  expr.$ = {
    env,
    value: createTypeValue(functionType),
    type: typeOfType(functionType),
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
