import {
  addVariableToEnv,
  Environment,
  popEnvFrame,
  pushEnvFrame,
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
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { PlaceholderToken } from "../../token";
import {
  areTypesCompatible,
  convertComptTypeToRuntimeType,
  createClosureType,
  createExprListType,
  createFunctionType,
  createType0,
  FunctionForallParameter,
  FunctionImplicitParameter,
  FunctionParameter,
  FunctionType,
  getFunctionParameterExprs,
  getFunctionParameterToken,
  getValueOfSomeTypeFromEnv,
  isClosureType,
  isExprListType,
  isExprType,
  isModuleType,
  isSomeType,
  prohibitVoidType,
  Type,
  typeOfType,
  typeProhibitsComptModifier,
  typeRequiresComptModifier,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { randomId } from "../../utils";
import {
  createTypeValue,
  createUnknownValue,
  isTypeValue,
  Value,
  valueToString,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isValidVariableName } from "../utils";
import { addARCFunctionsToClosureType } from "./utils";

/**
 * type:
 * i32 in (i32, ...)
 * (x: i32) in (x: i32, ...)
 */
export function evaluateFunctionParameter({
  expr,
  env,
  context,
  isParameterComptByDefault,
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
  isParameterComptByDefault: boolean;
}): { parameter: FunctionParameter; env: Environment } {
  let label: string | undefined = undefined;
  let isCompileTimeOnly: boolean = isParameterComptByDefault;
  let isQuote: boolean = false;
  let isHoldingTheRcValue: boolean = false;

  let lhsExpr: Expr | undefined = undefined;
  let rhsExpr: Expr | undefined = undefined;

  let parameterType: Type | undefined = undefined;
  let defaultValue: Value | undefined = undefined;
  let assignedValue: Value | undefined = undefined;

  let expr_: Expr = expr;
  let typeExpr: Expr | undefined = undefined;
  let labelExpr: Expr | undefined = undefined;
  let defaultValueExpr: Expr | undefined = undefined;
  let assignedValueExpr: Expr | undefined = undefined;

  if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, "=")) {
    // Check if this is `(T : Type) = Impl(Id)` syntax for assigned value with explicit type
    // The LHS should have a type annotation (`:`)
    const lhs = expr_.args[0];
    if (lhs && exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":", 2)) {
      // This is the explicit type form: (T : Type) = Impl(Id)
      lhsExpr = lhs;
      rhsExpr = expr_.args[1]!;
      assignedValueExpr = rhsExpr;
      expr_ = lhsExpr; // Continue parsing the lhs for label and type
    } else {
      throw formatErrorMessage({
        token: expr_.func.token,
        errorMessage: `Please use "?=" for default parameter value, not "=".`,
      });
    }
  }

  // Check if it's an assignment binding (`:=`)
  // eg:
  //   forall(T := Impl(Id))
  // Here T is the label, Impl(Id) is the assigned value (constraint)
  // The type is implicitly Type (for forall parameters)
  if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":=", 2)) {
    lhsExpr = expr_.args[0]!;
    rhsExpr = expr_.args[1]!;
    assignedValueExpr = rhsExpr;
    expr_ = lhsExpr; // Continue parsing the lhs for the label
  }

  // Check if there is defaultValue
  // eg:
  //   (x = 12)
  //   ((x: i32) ?= 13)
  if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, "?=", 2)) {
    rhsExpr = expr_.args[1]!;
    lhsExpr = expr_.args[0]!;
    defaultValueExpr = rhsExpr;
    expr_ = lhsExpr; // NOTE: Don't change the original `expr`
  }

  // Parse the lhs expr
  // eg:
  //   (x: i32)
  if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":", 2)) {
    rhsExpr = expr_.args[1]!;
    lhsExpr = expr_.args[0]!;
    typeExpr = rhsExpr;
  } else if (!assignedValueExpr) {
    // Only set typeExpr if it wasn't already set by `:=` handling
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
  } else {
    // assignedValueExpr was set by `:=`, expr_ is the label
    lhsExpr = expr_;
  }

  if (lhsExpr) {
    if (
      exprIsFunctionCall(lhsExpr) &&
      exprIsFunctionCallOf(lhsExpr, BuiltinKeywords.compt)
    ) {
      if (isParameterComptByDefault) {
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `"forall"/"using" parameters are "compt" by default. Not needed to use "compt" modifier.`,
        });
      }

      isCompileTimeOnly = true;
      if (lhsExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `Expected one argument for "compt" , got ${lhsExpr.args.length}`,
        });
      }
      lhsExpr = lhsExpr.args[0]!;
    }

    if (exprIsFunctionCall(lhsExpr) && exprIsFunctionCallOf(lhsExpr, "own")) {
      isHoldingTheRcValue = true;
      if (lhsExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `Expected one argument for "own", got ${lhsExpr.args.length}`,
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

  // We require to have label for function parameters
  if (!label) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected a label for function parameter, got ${exprToString(expr)}`,
    });
    // label = generateNewTempVariableName(this.modulePath);
  }

  // Disallow to have label "Self" as it causes a lot of problem
  if (label === "Self") {
    throw formatErrorMessage({
      token: labelExpr?.token ?? expr.token,
      errorMessage: "Not allowed to use 'Self' as the label.",
    });
  }

  {
    // Evaluate the assignedValueExpr if exists (for `:=` syntax)
    // eg: forall(T := Impl(Id))
    // The assigned value becomes the value of the parameter, and the type is Type
    if (assignedValueExpr) {
      const evaluatedAssignedValue = evaluateExpression({
        expr: assignedValueExpr,
        env,
        context: { ...context },
      });
      if (!evaluatedAssignedValue.$) {
        throw formatErrorMessage({
          token: assignedValueExpr.token,
          errorMessage: `Failed to evaluate assigned value expression: ${exprToString(assignedValueExpr)}`,
        });
      }
      env = evaluatedAssignedValue.$.env;

      // The assigned value should be a TypeValue (e.g., Impl(Id) returns a TypeValue)
      const assignedValue_ = evaluatedAssignedValue.$.value;
      if (!isTypeValue(assignedValue_)) {
        throw formatErrorMessage({
          token: assignedValueExpr.token,
          errorMessage: `Expected type value for := assignment, got ${valueToString(assignedValue_)}`,
        });
      }

      // The parameter type is Type (the type of types)
      parameterType = createType0();
      // Store the assigned TypeValue separately from defaultValue
      assignedValue = assignedValue_;

      // Validate that assignedValue is only used with compile-time parameters
      if (!isCompileTimeOnly) {
        throw formatErrorMessage({
          token: assignedValueExpr.token,
          errorMessage: `Assigned value (:= or =) is only allowed for compile-time parameters. Use "compt(${label})" or put this in "forall(...)".`,
        });
      }
    }

    // Evaluate the typeExpr if exists
    if (typeExpr) {
      // Parse the rhs expr which should be a type
      const evaluatedRhs = evaluateExpression({
        expr: typeExpr,
        env,
        context: { ...context },
      });
      if (!evaluatedRhs.$) {
        console.log(
          context.SelfType ? typeToString(context.SelfType) : undefined,
          exprToString(typeExpr)
        );
        throw formatErrorMessage({
          token: typeExpr.token,
          errorMessage: `(3) Failed to evaluate type expression: ${exprToString(typeExpr)}`,
        });
      }
      env = evaluatedRhs.$.env;

      // Expected the evaluatedRhs to be a type
      const typeValue = evaluatedRhs.$.value;
      if (isTypeValue(typeValue)) {
        parameterType = typeValue.value;
      }
      // else if (
      //   isUnknownValue(typeValue) &&
      //   isTypeHierarchyType(typeValue.type)
      // ) {
      //   parameterType = createSomeType(typeValue.type, label);
      // }
      else {
        throw formatErrorMessage({
          token: typeExpr.token,
          errorMessage: `Expected type for function parameter, got ${valueToString(typeValue)}`,
        });
      }
    }

    // Evaluate the defaultValueExpr if exists
    if (defaultValueExpr) {
      const evaluatedDefaultValue = evaluateExpression({
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
      parameterType = convertComptTypeToRuntimeType({
        type: parameterType,
        expectedType: undefined,
        expr: undefined,
        env,
        context: { ...context },
      });

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

  const value = isCompileTimeOnly
    ? createUnknownValue(parameterType, label)
    : undefined;

  // Prohibit void type as parameter type
  if (!context.isUnsafeFunctionType) {
    prohibitVoidType(parameterType, typeExpr?.token ?? expr.token);
  }

  // Check if the parameterType is a valid module type
  if (isModuleType(parameterType)) {
    if (!parameterType.receiverType) {
      throw formatErrorMessage({
        token: typeExpr?.token ?? expr.token,
        errorMessage: `Module type without receiver type set cannot be used as function parameter type.
        
Please consider using "<:" to specify the receiver type for a module type, for example:

Id :: module
  id   : (fn(self : Self) -> Self)
;

use_id :: (fn(forall(T : Type),
              val : T, 
              using(IdModule) : (T <: Id)
          ) -> T) {
  return IdModule.id(val);
}
`,
      });
    }
  }

  // Add the parameter to the env
  // console.log("(9) addVariableToEnv");
  const { env: nextEnv } = addVariableToEnv({
    env,
    variable: {
      name: label,
      type: parameterType,
      isCompileTimeOnly: isCompileTimeOnly,
      value:
        // If there's an assignedValue (from := syntax), use it
        // Otherwise use a generic unknown value for compile-time params
        assignedValue ??
        (isCompileTimeOnly
          ? createUnknownValue(parameterType, label)
          : undefined),
      token: lhsExpr?.token ?? expr.token,
      initializedAtToken: lhsExpr?.token ?? expr.token, // Set as initialized
      consumedAtToken: undefined, // Not consumed yet
      isHoldingTheRcValue: isHoldingTheRcValue,
      isHoldingTheSameRcValueAs: undefined, // Parameters don't borrow from other variables
      isReassignable: false, // Mark as not reassigable
    },
    skipCheckingFunctionOverloading: true,
  });
  env = nextEnv;

  if (lhsExpr) {
    lhsExpr.$ = {
      env,
      type: parameterType,
      value: value,
      pathCollection: [],
    };
  }

  if (lhsExpr !== expr && typeExpr !== expr) {
    expr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      pathCollection: [],
    };
  }

  // Validate closure mutability requirements
  if (isClosureType(parameterType)) {
    // Note: With the new simplified closure system, we don't have different closure kinds
    // All closures work the same way now
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
        assignedValueExpr,
      }),
      isCompileTimeOnly,
      isQuote,
      isHoldingTheRcValue,
      assignedValue,
    },
    env,
  };
}

/**
 * NOTE: Calling this function will increase the env frame.
 */
export function evaluateFunctionParameters({
  parameterExprs,
  env,
  context,
}: {
  parameterExprs: Expr[];
  env: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
}): {
  parameters: FunctionParameter[];
  forallParameters: FunctionParameter[];
  implicitParameters: FunctionParameter[];
  variadicParameter?: FunctionParameter;
  env: Environment;
} {
  env = pushEnvFrame(env);

  const parameters: FunctionParameter[] = [];
  const forallParameters: FunctionParameter[] = [];
  const implicitParameters: FunctionParameter[] = [];
  let variadicParameter: FunctionParameter | undefined = undefined;

  let findVariadicParameter = false;

  for (let i = 0; i < parameterExprs.length; i++) {
    const parameterExpr = parameterExprs[i]!;

    // Check if it's the type parameters
    if (
      exprIsFunctionCall(parameterExpr) &&
      exprIsFunctionCallOf(parameterExpr, BuiltinKeywords.forall)
    ) {
      if (i !== 0) {
        throw formatErrorMessage({
          token: parameterExpr.token,
          errorMessage: `Expected type parameters to be the first argument, got ${i + 1}`,
        });
      }
      const typeParameterExprs = parameterExpr.args;

      for (let j = 0; j < typeParameterExprs.length; j++) {
        const typeParameterExpr = typeParameterExprs[j]!;
        const { parameter, env: nextEnv } = evaluateFunctionParameter({
          expr: typeParameterExpr,
          env,
          context: {
            ...context,
          },
          isParameterComptByDefault: true,
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

        forallParameters.push(parameter);
        env = nextEnv;
      }
    }
    // Check if it's an implicit parameter with new syntax: using(name) : Type
    else if (
      exprIsFunctionCall(parameterExpr) &&
      exprIsFunctionCallOf(parameterExpr, ":", 2) &&
      exprIsFunctionCall(parameterExpr.args[0]!) &&
      exprIsFunctionCallOf(parameterExpr.args[0]!, BuiltinKeywords.using, 1)
    ) {
      // Enforce ordering: using(...) parameters must come after all regular parameters
      if (parameters.length === 0 && i > 0) {
        // We have implicit params but haven't seen any regular params yet
        // This is only okay if we're right after forall
        const hasForallBefore = forallParameters.length > 0;
        if (!hasForallBefore && i > 0) {
          throw formatErrorMessage({
            token: parameterExpr.token,
            errorMessage: `Implicit parameters using(...) must come after regular parameters.
Expected order: forall(...), regular parameters, using(...)`,
          });
        }
      }

      // New syntax: using(name) : Type
      const usingCall = parameterExpr.args[0]! as FuncCallExpr;
      const nameExpr = usingCall.args[0]!;
      const typeExpr = parameterExpr.args[1]!;

      // Reconstruct as (name : Type) for evaluateFunctionParameter
      const reconstructedExpr: FuncCallExpr = {
        ...parameterExpr,
        args: [nameExpr, typeExpr],
      };

      const { parameter, env: nextEnv } = evaluateFunctionParameter({
        expr: reconstructedExpr,
        env,
        context: {
          ...context,
        },
        isParameterComptByDefault: true,
      });

      // Implicit parameter cannot have default value
      if (parameter.exprs.defaultValueExpr) {
        throw formatErrorMessage({
          token: parameterExpr.token,
          errorMessage: `Implicit parameter cannot have default value, got ${exprToString(
            parameterExpr
          )}`,
        });
      }

      // Check if there is duplicate labels
      const duplicateLabel = implicitParameters.find(
        (element) => element.label === parameter.label
      );
      if (duplicateLabel) {
        throw formatErrorMessage({
          token: nameExpr.token,
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
            token: nameExpr.token,
            errorMessage: `Compile-time parameters must appear first in the implicit parameter list.`,
          });
        }
      }

      implicitParameters.push(parameter);
      env = nextEnv;
    }
    // Check if it's a where clause: where(T <: Module1, U <: Module2, ...)
    else if (
      exprIsFunctionCall(parameterExpr) &&
      exprIsFunctionCallOf(parameterExpr, BuiltinKeywords.where)
    ) {
      // where clause must be the last parameter
      if (i !== parameterExprs.length - 1) {
        throw formatErrorMessage({
          token: parameterExpr.token,
          errorMessage: `The where clause must be the last parameter in the function signature.`,
        });
      }

      // Process each constraint in the where clause
      const constraintExprs = parameterExpr.args;
      if (constraintExprs.length === 0) {
        throw formatErrorMessage({
          token: parameterExpr.token,
          errorMessage: `The where clause must have at least one constraint.`,
        });
      }

      for (const constraintExpr of constraintExprs) {
        // Each constraint must be of the form: T <: Module or T <: (Module1, Module2)
        if (
          !exprIsFunctionCall(constraintExpr) ||
          !exprIsFunctionCallOf(constraintExpr, "<:", 2)
        ) {
          throw formatErrorMessage({
            token: constraintExpr.token,
            errorMessage: `Expected constraint in the form "T <: Module" or "T <: (Module1, Module2)", got: ${exprToString(constraintExpr)}`,
          });
        }

        // Evaluate with isInsideWhereClause context
        // subtype_of.ts handles both single module and tuple of modules
        const evaluated = evaluateExpression({
          expr: constraintExpr,
          env,
          context: {
            ...context,
            isInsideWhereClause: true,
          },
        });
        if (evaluated.$?.env) {
          env = evaluated.$.env;
        }
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
        isQuote,
        label: parameterName,
        type: parameterType,
        isHoldingTheRcValue: false,
      };

      if (parameterName !== "...") {
        // Add the parameter to the environment
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: parameterName,
            type: parameterType,
            isCompileTimeOnly: variadicParameter.isCompileTimeOnly,
            value: isCompileTimeOnly
              ? createUnknownValue(parameterType, parameterName)
              : undefined,
            token: labelExpr.token,
            initializedAtToken: labelExpr.token, // Set as initialized
            consumedAtToken: undefined, // Not consumed yet
            isHoldingTheRcValue: variadicParameter.isHoldingTheRcValue,
            isHoldingTheSameRcValueAs: undefined, // Parameters don't borrow from other variables
            isReassignable: false, // Mark as not reassigable
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
          pathCollection: [],
        };
      }
    }
    // Normal function parameters
    else {
      // Enforce ordering: cannot have regular parameters after using(...) parameters
      if (implicitParameters.length > 0) {
        throw formatErrorMessage({
          token: parameterExpr.token,
          errorMessage: `Regular parameters must come before implicit parameters using(...).
Expected order: forall(...), regular parameters, using(...)`,
        });
      }

      if (findVariadicParameter) {
        throw formatErrorMessage({
          token: parameterExpr.token,
          errorMessage: `Expected variadic parameter to be the last parameter before the normal parameters.`,
        });
      }

      const { parameter, env: nextEnv } = evaluateFunctionParameter({
        expr: parameterExpr,
        env,
        context: {
          ...context,
        },
        isParameterComptByDefault: false,
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
 * - fn(x : i32) => i32;     // closure type with capture inference.
 */
export function evaluateFunctionType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  // Detect operator type to determine if it's a closure
  const isClosure = exprIsFunctionCallOf(expr, "=>", 2);
  const isRegularFunction = exprIsFunctionCallOf(expr, "->", 2);

  if (!isClosure && !isRegularFunction) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected -> for function type or => for closure type, got:\n${exprToString(expr)}`,
    });
  }

  const argListExpr = expr.args[0]!;
  const returnExpr = expr.args[1]!;

  // Handle different forms of parameter lists
  let argList: Expr[] = [];

  // For both regular functions and closures, expect fn(...) syntax
  if (
    exprIsFunctionCall(argListExpr) &&
    (exprIsFunctionCallOf(argListExpr, BuiltinKeywords.fn) ||
      exprIsFunctionCallOf(argListExpr, BuiltinKeywords.unsafe_fn))
  ) {
    argList = argListExpr.args;
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
      isEvaluatingFunctionType: true,
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
  const evaluatedReturnType = evaluateExpression({
    expr: returnTypeExpr,
    env,
    context: { ...context, isEvaluatingFunctionType: true },
  });

  // Check that the return type is indeed a type
  let returnType: Type;
  const returnTypeValue = evaluatedReturnType.$?.value;
  if (isTypeValue(returnTypeValue)) {
    returnType = returnTypeValue.value;
  }
  // else if (
  //   isUnknownValue(returnTypeValue) &&
  //   isTypeHierarchyType(returnTypeValue.type)
  // ) {
  //   returnType = createSomeType(
  //     returnTypeValue.type,
  //     returnLabel ?? `sometype_${randomId()}` // QUESTION: Is it right to use randomId() here?
  //   );
  // }
  else {
    throw formatErrorMessage({
      token: returnTypeExpr.token,
      errorMessage: `Expected a type for function return type, got:\n${exprToString(
        returnTypeExpr
      )}`,
    });
  }

  if (typeRequiresComptModifier(returnType) && !isReturnTypeCompileTimeOnly) {
    // Try converting to runtime type first
    returnType = convertComptTypeToRuntimeType({
      type: returnType,
      expectedType: undefined,
      expr: undefined,
      env,
      context: { ...context },
    });
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

  // Prohibit the return type to be void
  if (!context.isUnsafeFunctionType) {
    prohibitVoidType(returnType, returnTypeExpr.token);
  }

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
    forallParameters: forallParameters as FunctionForallParameter[],
    implicitParameters: implicitParameters as FunctionImplicitParameter[],
    variadicParameter,
    return_: {
      type: returnType,
      expr: returnTypeExpr,
      isCompileTimeOnly: isReturnTypeCompileTimeOnly,
      isUnquote: isReturnTypeUnquote,
      label: returnLabel ?? `fn_return_${randomId()}`,
    },
    env: popEnvFrame(env, true),
    parametersFrame: env.frames[env.frames.length - 1]!,
    SelfType: context.SelfType,
    isClosure: isClosure,
  });

  // Create ClosureType if this is a closure, otherwise use FunctionType
  let finalType;
  if (isClosure) {
    finalType = createClosureType(functionType, env);
    env = addARCFunctionsToClosureType({
      closureType: finalType,
      env,
      context,
    });
  } else {
    finalType = functionType;
  }

  // Pop the environment frame
  env = popEnvFrame(env, true);

  // Set the type and value of the expression
  expr.$ = {
    env,
    value: createTypeValue(finalType),
    type: typeOfType(finalType),
    pathCollection: [],
  };
  return expr;
}

export function evaluateFunctionParameterTypeAgain({
  parameter,
  calleeEnv,
  context,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  functionType,
}: {
  parameter: FunctionParameter;
  calleeEnv: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
  functionType: FunctionType;
}): { parameterType: Type; calleeEnv: Environment } {
  const typeExpr = parameter.exprs.typeExpr;
  const defaultValueExpr = parameter.exprs.defaultValueExpr;
  if (typeExpr) {
    const evaluatedTypeExpr = evaluateExpression({
      expr: cloneExpr(typeExpr),
      env: calleeEnv,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: functionType.SelfType,
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

    // Update parameter in callee env
    // const existingVariables = getVariablesFromEnv(calleeEnv, parameter.label);
    // if (existingVariables.length) {
    //   const existingVariable = existingVariables[existingVariables.length - 1]!;
    //   calleeEnv = updateExistingVariable(calleeEnv, existingVariable, {
    //     ...existingVariable,
    //     type: parameterType,
    //     value: parameter.isCompileTimeOnly
    //       ? createUnknownValue(parameterType, parameter.label)
    //       : undefined,
    //   });
    // } else {
    //   const { env: nextEnv } = addVariableToEnv({
    //     env: calleeEnv,
    //     variable: {
    //       name: parameter.label,
    //       type: parameterType,
    //       isMutable: parameter.isMutable,
    //       isCompileTimeOnly: parameter.isCompileTimeOnly,
    //       value: parameter.isCompileTimeOnly
    //         ? createUnknownValue(parameterType, parameter.label)
    //         : undefined,
    //       token: typeExpr.token,
    //       initializedAtToken: typeExpr.token,
    //       consumedAtToken: undefined,
    //     },
    //   });
    //   calleeEnv = nextEnv;
    //
    //   // throw formatErrorMessage({
    //   //   token: typeExpr.token,
    //   //   errorMessage: `Expected parameter "${parameter.label}" to be defined in the environment.`,
    //   // });
    // }

    return {
      parameterType,
      calleeEnv,
    };
  } else if (defaultValueExpr) {
    const evaluatedDefaultValueExpr = evaluateExpression({
      expr: cloneExpr(defaultValueExpr),
      env: calleeEnv,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: functionType.SelfType,
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

    // Update parameter in callee env
    // const existingVariables = getVariablesFromEnv(calleeEnv, parameter.label);
    // if (existingVariables.length) {
    //   const existingVariable = existingVariables[existingVariables.length - 1]!;
    //   calleeEnv = updateExistingVariable(calleeEnv, existingVariable, {
    //     ...existingVariable,
    //     type: parameterType,
    //     value: parameter.isCompileTimeOnly
    //       ? createUnknownValue(parameterType, parameter.label)
    //       : undefined,
    //   });
    // } else {
    //   throw formatErrorMessage({
    //     token: defaultValueExpr.token,
    //     errorMessage: `Expected parameter "${parameter.label}" to be defined in the environment.`,
    //   });
    // }
    //
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

export function evaluateFunctionReturnTypeAgain({
  functionType,
  calleeEnv,
  context,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  functionCalleeExpr,
}: {
  functionType: FunctionType;
  calleeEnv: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
  functionCalleeExpr?: Expr;
}): { returnType: Type; calleeEnv: Environment } {
  const functionReturn = functionType.return;
  if (!functionReturn.expr) {
    return { returnType: functionReturn.type, calleeEnv };
  }
  const evaluatedFunctionReturnExpr = evaluateExpression({
    expr: cloneExpr(functionReturn.expr),
    env: calleeEnv,
    context: {
      ...context,
      SelfType: functionType.SelfType,
    },
  });

  let returnType: Type;
  const functionReturnTypeValue = evaluatedFunctionReturnExpr.$?.value;
  if (isTypeValue(functionReturnTypeValue)) {
    returnType = functionReturnTypeValue.value;
  } else {
    throw formatErrorMessage({
      token: functionCalleeExpr?.token ?? PlaceholderToken,
      errorMessage: `Function body is not evaluated correctly. Expected to return a type.`,
    });
  }

  if (isSomeType(returnType)) {
    const newReturnType = getValueOfSomeTypeFromEnv(calleeEnv, returnType);
    returnType = newReturnType;
  }

  return {
    returnType,
    calleeEnv: evaluatedFunctionReturnExpr.$?.env ?? calleeEnv,
  };
}
