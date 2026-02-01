import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
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
  FnCallExpr,
} from "../../expr";
import { PlaceholderToken } from "../../token";
import {
  areTypesCompatible,
  convertComptimeTypeToRuntimeType,
  createExprListType,
  createFunctionType,
  createSomeType,
  createType0,
  FunctionForallParameter,
  FunctionParameter,
  FunctionType,
  getFunctionParameterExprs,
  getFunctionParameterToken,
  getValueOfSomeTypeFromEnv,
  isExprListType,
  isExprType,
  isFnTraitType,
  isFunctionType,
  isSomeType,
  isTraitType,
  prohibitVoidType,
  SomeType,
  TraitType,
  Type,
  typeOfType,
  typeProhibitsComptimeModifier,
  typeRequiresComptimeModifier,
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
import { typeImplementsTrait } from "../exprs/subtype_of";
import { isValidVariableName } from "../utils";

/**
 * type:
 * i32 in (i32, ...)
 * (x: i32) in (x: i32, ...)
 */
export function evaluateFunctionParameter({
  expr,
  env,
  context,
  isParameterComptimeByDefault,
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
  isParameterComptimeByDefault: boolean;
}): { parameter: FunctionParameter; env: Environment } {
  let label: string | undefined = undefined;
  let isCompileTimeOnly: boolean = isParameterComptimeByDefault;
  let isQuote: boolean = false;
  let isOwningTheRcValue: boolean = false;

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
      exprIsFunctionCallOf(lhsExpr, BuiltinKeywords.comptime)
    ) {
      if (isParameterComptimeByDefault) {
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `"forall"/"using" parameters are "comptime" by default. Not needed to use "comptime" modifier.`,
        });
      }

      isCompileTimeOnly = true;
      if (lhsExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `Expected one argument for "comptime" , got ${lhsExpr.args.length}`,
        });
      }
      lhsExpr = lhsExpr.args[0]!;
    }

    if (exprIsFunctionCall(lhsExpr) && exprIsFunctionCallOf(lhsExpr, "own")) {
      isOwningTheRcValue = true;
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
          errorMessage: `Cannot use "comptime"  with "quote" (or ":"). "quote" parameters means compile-time only, so "comptime" is redundant.`,
        });
      }
      isCompileTimeOnly = true;

      lhsExpr = lhsExpr.args[0]!;
    }

    if (!exprIsAtom(lhsExpr) || !isValidVariableName(lhsExpr)) {
      throw formatErrorMessage({
        token: lhsExpr.token,
        errorMessage: `Expected identifier for parameter label, got ${exprToString(lhsExpr)}`,
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
          errorMessage: `Assigned value (:= or =) is only allowed for compile-time parameters. Use "comptime(${label})" or put this in "forall(...)".`,
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
    if (
      isCompileTimeOnly &&
      typeProhibitsComptimeModifier(parameterType, env)
    ) {
      throw formatErrorMessage({
        token: lhsExpr?.token ?? expr.token,
        errorMessage: `Parameter marked as "comptime" but type is not available at compile-time:
${typeToString(parameterType)}`,
      });
    }
    if (
      !isCompileTimeOnly &&
      typeRequiresComptimeModifier(parameterType, env)
    ) {
      throw formatErrorMessage({
        token: lhsExpr?.token ?? expr.token,
        errorMessage: `Parameter marked as runtime but type is not available at runtime:
${typeToString(parameterType)}`,
      });
    }

    // Validate that runtime parameters with intrinsically generic function types are prohibited
    // Functions that have their own forall parameters or compile-time parameters require
    // specialization and cannot be represented as runtime function pointers.
    // However, functions that merely reference type variables from enclosing scope are allowed (like Rust)
    if (
      !isCompileTimeOnly &&
      isFunctionType(parameterType) &&
      // NOTE: Don't use isFunctionSpecializable here. It's too broad.
      (parameterType.forallParameters.length > 0 ||
        parameterType.parameters.some((p) => p.isCompileTimeOnly))
    ) {
      throw formatErrorMessage({
        token: lhsExpr?.token ?? expr.token,
        errorMessage: `Runtime function parameters with generic function types are not allowed:
${typeToString(parameterType)}

Generic functions must be compile-time known to enable monomorphization. Consider using:
comptime(${label}) : ${typeToString(parameterType)}`,
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
    ? createUnknownValue(parameterType, { variableName: label, env, context })
    : undefined;

  // Prohibit void type as parameter type
  if (!context.isUnsafeFunctionType) {
    prohibitVoidType(parameterType, typeExpr?.token ?? expr.token);
  }

  // Check if the parameterType is a valid trait type
  if (isTraitType(parameterType)) {
    if (!parameterType.receiverType) {
      throw formatErrorMessage({
        token: typeExpr?.token ?? expr.token,
        errorMessage: `Trait type without receiver type set cannot be used as function parameter type.
        
Please consider using "<:" to specify the receiver type for a trait type, for example:

Id :: trait
  id   : (fn(self : Self) -> Self)
;

use_id :: (fn(forall(T : Type),
              val : T, 
              where(T <: Id)
          ) -> T) {
  return val.id();
}
`,
      });
    }
  }

  // Add the parameter to the env
  // Check if the variable already exists (from where clause processing)
  const existingVars = getVariablesFromEnv(env, label);
  const existingWhereClauseVar = existingVars.find((v) => {
    // Check if this is a SomeType created by where clause for this exact label
    if (v.value && isTypeValue(v.value[0])) {
      const typeVal = v.value[0]!;
      if (isSomeType(typeVal.value)) {
        return true;
      }
    }
    return false;
  });

  // Track the actual value to use for this parameter
  let actualValue: Value | undefined = value;
  let actualParameterType: Type = parameterType;

  if (existingWhereClauseVar) {
    // Variable already exists from where clause - we need to merge constraints
    const existingTypeValue = existingWhereClauseVar.value![0] as Value & {
      value: SomeType;
    };
    const existingSomeType = existingTypeValue.value;

    // Get the new value (could be a SomeType from := syntax like Impl(Trait))
    const newValue = assignedValue
      ? assignedValue
      : isCompileTimeOnly
        ? createUnknownValue(parameterType, {
            variableName: label,
            env,
            context,
          })
        : undefined;

    // Check if the new value is also a TypeValue containing a SomeType
    if (newValue && isTypeValue(newValue) && isSomeType(newValue.value)) {
      const newSomeType = newValue.value;

      // Merge required traits from both SomeTypes
      const mergedRequiredTraits = [...existingSomeType.requiredTraits];
      for (const trait of newSomeType.requiredTraits) {
        if (!mergedRequiredTraits.some((t) => t.id === trait.id)) {
          mergedRequiredTraits.push(trait);
        }
      }

      // Merge negative traits
      const mergedNegativeTraits = [...(existingSomeType.negativeTraits ?? [])];
      if (newSomeType.negativeTraits) {
        for (const trait of newSomeType.negativeTraits) {
          if (!mergedNegativeTraits.some((t) => t.id === trait.id)) {
            mergedNegativeTraits.push(trait);
          }
        }
      }

      // Update the existing SomeType with merged traits
      existingSomeType.requiredTraits = mergedRequiredTraits;
      existingSomeType.negativeTraits =
        mergedNegativeTraits.length > 0 ? mergedNegativeTraits : undefined;
    }
    // If new value is not a SomeType, just keep the existing SomeType
    // (this handles cases like `comptime(T): Type` after `where(T <: Trait)`)

    // Use the existing SomeType as the actual value for this parameter
    actualValue = existingTypeValue;
    actualParameterType = typeOfType(existingSomeType);
  } else {
    // No existing variable - add new one
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: label,
        type: parameterType,
        isCompileTimeOnly: isCompileTimeOnly,
        value:
          // If there's an assignedValue (from := syntax), use it
          // Otherwise use a generic unknown value for compile-time params
          assignedValue
            ? [assignedValue]
            : isCompileTimeOnly
              ? [
                  createUnknownValue(parameterType, {
                    variableName: label,
                    env,
                    context,
                  }),
                ]
              : undefined,
        token: lhsExpr?.token ?? expr.token,
        initializedAtToken: lhsExpr?.token ?? expr.token, // Set as initialized
        consumedAtToken: undefined, // Not consumed yet
        isOwningTheRcValue: isOwningTheRcValue,
        isOwningTheSameRcValueAs: undefined, // Parameters don't borrow from other variables
        isReassignable: false, // Mark as not reassigable
      },
    });
    env = nextEnv;
  }

  if (lhsExpr) {
    lhsExpr.$ = {
      env,
      type: actualParameterType,
      value: actualValue,
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
  if (isFnTraitType(parameterType)) {
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
      isOwningTheRcValue,
      assignedValue,
    },
    env,
  };
}

/**
 * First pass of where clause processing: scan LHS variables, create SomeTypes for them,
 * and try to evaluate constraints. If a constraint fails (e.g., references undefined variables),
 * store it for later retry.
 */
function prepareWhereClauseVariables({
  constraintExprs,
  env,
  context,
}: {
  constraintExprs: Expr[];
  env: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
}): {
  env: Environment;
  pendingConstraints: Expr[];
  whereClauseConstraints?: Map<
    SomeType,
    {
      requiredTraits: TraitType[];
      negativeTraits: TraitType[];
    }
  >;
} {
  const pendingConstraints: Expr[] = [];
  let whereClauseConstraints:
    | Map<
        SomeType,
        {
          requiredTraits: TraitType[];
          negativeTraits: TraitType[];
        }
      >
    | undefined = undefined;

  for (const constraintExpr of constraintExprs) {
    // Each constraint must be of the form: T <: Trait or T <: (Trait1, Trait2)
    if (
      !exprIsFunctionCall(constraintExpr) ||
      !exprIsFunctionCallOf(constraintExpr, "<:", 2)
    ) {
      // Skip validation here - will be done in parseWhereClauseConstraints
      continue;
    }

    const lhsExpr = constraintExpr.args[0]!;

    // First, ensure LHS variable exists (create SomeType if needed)
    if (exprIsAtom(lhsExpr)) {
      const varName = lhsExpr.token.value;

      // Check if variable already exists in env
      const existingVars = getVariablesFromEnv(env, varName);
      if (existingVars.length === 0) {
        // Variable doesn't exist - create a new SomeType for it
        const someType = createSomeType(createType0(), varName, {
          env,
          context,
        });

        // Add to env so later parameters can reference it
        const typeValue = createTypeValue(someType);
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: varName,
            type: typeOfType(someType),
            isCompileTimeOnly: true,
            value: [typeValue],
            token: lhsExpr.token,
            initializedAtToken: lhsExpr.token,
            consumedAtToken: undefined,
            isOwningTheRcValue: false,
            isOwningTheSameRcValueAs: undefined,
            isReassignable: false,
          },
        });
        env = nextEnv;

        // Set $ on the expr
        lhsExpr.$ = {
          env,
          type: typeOfType(someType),
          value: typeValue,
          pathCollection: [],
        };
      }
    }

    // Now try to evaluate the full constraint
    // If it fails (e.g., RHS references undefined variable), store for later retry
    try {
      const result = parseWhereClauseConstraints({
        constraintExprs: [constraintExpr],
        env,
        context,
      });
      env = result.env;

      // Merge constraints
      if (result.whereClauseConstraints) {
        if (!whereClauseConstraints) {
          whereClauseConstraints = result.whereClauseConstraints;
        } else {
          // Merge with existing constraints
          for (const [someType, constraints] of result.whereClauseConstraints) {
            const existing = whereClauseConstraints.get(someType);
            if (existing) {
              existing.requiredTraits.push(...constraints.requiredTraits);
              existing.negativeTraits.push(...constraints.negativeTraits);
            } else {
              whereClauseConstraints.set(someType, constraints);
            }
          }
        }
      }
    } catch (error) {
      // Constraint evaluation failed - store for later retry
      pendingConstraints.push(constraintExpr);
    }
  }

  return { env, pendingConstraints, whereClauseConstraints };
}

/**
 * Retry pending where clause constraints that previously failed.
 * Returns updated env, remaining pending constraints, and any new whereClauseConstraints.
 */
function retryPendingConstraints({
  pendingConstraints,
  env,
  context,
  existingWhereClauseConstraints,
}: {
  pendingConstraints: Expr[];
  env: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
  existingWhereClauseConstraints?: Map<
    SomeType,
    {
      requiredTraits: TraitType[];
      negativeTraits: TraitType[];
    }
  >;
}): {
  env: Environment;
  pendingConstraints: Expr[];
  whereClauseConstraints?: Map<
    SomeType,
    {
      requiredTraits: TraitType[];
      negativeTraits: TraitType[];
    }
  >;
} {
  const stillPending: Expr[] = [];
  let whereClauseConstraints = existingWhereClauseConstraints;

  for (const constraintExpr of pendingConstraints) {
    try {
      const result = parseWhereClauseConstraints({
        constraintExprs: [constraintExpr],
        env,
        context,
      });
      env = result.env;

      // Merge constraints
      if (result.whereClauseConstraints) {
        if (!whereClauseConstraints) {
          whereClauseConstraints = result.whereClauseConstraints;
        } else {
          // Merge with existing constraints
          for (const [someType, constraints] of result.whereClauseConstraints) {
            const existing = whereClauseConstraints.get(someType);
            if (existing) {
              existing.requiredTraits.push(...constraints.requiredTraits);
              existing.negativeTraits.push(...constraints.negativeTraits);
            } else {
              whereClauseConstraints.set(someType, constraints);
            }
          }
        }
      }
    } catch (error) {
      // Still can't evaluate - keep it pending
      stillPending.push(constraintExpr);
    }
  }

  return { env, pendingConstraints: stillPending, whereClauseConstraints };
}

/**
 * Parse where clause constraints from constraint expressions.
 * Handles forms like: T <: Trait, T <: (Trait1, Trait2), T <: !(Trait)
 *
 * Assumes all LHS variables already exist in env (either from forall, regular params, or prepareWhereClauseVariables).
 */
function parseWhereClauseConstraints({
  constraintExprs,
  env,
  context,
}: {
  constraintExprs: Expr[];
  env: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
}): {
  whereClauseConstraints: Map<
    SomeType,
    {
      requiredTraits: TraitType[];
      negativeTraits: TraitType[];
    }
  >;
  env: Environment;
} {
  const whereClauseConstraints = new Map<
    SomeType,
    {
      requiredTraits: TraitType[];
      negativeTraits: TraitType[];
    }
  >();

  for (const constraintExpr of constraintExprs) {
    // Each constraint must be of the form: T <: Trait or T <: (Trait1, Trait2)
    if (
      !exprIsFunctionCall(constraintExpr) ||
      !exprIsFunctionCallOf(constraintExpr, "<:", 2)
    ) {
      throw formatErrorMessage({
        token: constraintExpr.token,
        errorMessage: `Expected constraint in the form "T <: Trait" or "T <: (Trait1, Trait2)", got: ${exprToString(constraintExpr)}`,
      });
    }

    const lhsExpr = constraintExpr.args[0]!;
    const rhsExpr = constraintExpr.args[1]!;

    // Check if LHS is a simple variable name
    let someType: SomeType;

    if (exprIsAtom(lhsExpr)) {
      const varName = lhsExpr.token.value;

      // Check if variable already exists in env
      const existingVars = getVariablesFromEnv(env, varName);
      if (existingVars.length > 0) {
        const existingVar = existingVars[existingVars.length - 1]!;
        if (
          existingVar.value &&
          isTypeValue(existingVar.value[0]) &&
          isSomeType(existingVar.value[0].value)
        ) {
          someType = existingVar.value[0].value as SomeType;
        } else if (existingVar.value && isTypeValue(existingVar.value[0])) {
          // It's a concrete type - validate constraints immediately
          const concreteType = existingVar.value[0].value as Type;
          env = validateConcreteTypeConstraints({
            concreteType,
            rhsExpr,
            constraintExpr,
            env,
            context,
          });
          continue;
        } else {
          throw formatErrorMessage({
            token: lhsExpr.token,
            errorMessage: `Expected type for left-hand side of where clause constraint, got variable "${varName}".`,
          });
        }
      } else {
        // Variable doesn't exist - create a new SomeType for it
        // This SomeType starts with RUNTIME_ONLY availability (default for type parameters)
        someType = createSomeType(createType0(), varName, { env, context });

        // Add to env so later parameters can reference it
        const typeValue = createTypeValue(someType);
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: varName,
            type: typeOfType(someType),
            isCompileTimeOnly: true,
            value: [typeValue],
            token: lhsExpr.token,
            initializedAtToken: lhsExpr.token,
            consumedAtToken: undefined,
            isOwningTheRcValue: false,
            isOwningTheSameRcValueAs: undefined,
            isReassignable: false,
          },
        });
        env = nextEnv;

        // Set $ on the expr
        lhsExpr.$ = {
          env,
          type: typeOfType(someType),
          value: typeValue,
          pathCollection: [],
        };
      }
    } else {
      // Evaluate the LHS expression (must be a SomeType - type parameter)
      const evaluatedLhs = evaluateExpression({
        expr: lhsExpr,
        env,
        context: { ...context },
      });
      if (
        !evaluatedLhs.$ ||
        !evaluatedLhs.$.value ||
        !isTypeValue(evaluatedLhs.$.value)
      ) {
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `Expected type for left-hand side of where clause constraint.`,
        });
      }
      env = evaluatedLhs.$.env;

      const lhsTypeValue = evaluatedLhs.$.value;

      // Check if this is a SomeType (type parameter) or a concrete type
      if (!isSomeType(lhsTypeValue.value)) {
        // It's a concrete type - validate constraints immediately
        env = validateConcreteTypeConstraints({
          concreteType: lhsTypeValue.value,
          rhsExpr,
          constraintExpr,
          env,
          context,
        });
        continue;
      }

      someType = lhsTypeValue.value;
    }

    // Parse RHS: can be Trait, (Trait1, Trait2), !(Trait), or (!(Trait1), Trait2)
    const traitExprs: { expr: Expr; isNegated: boolean }[] = [];
    if (
      exprIsFunctionCall(rhsExpr) &&
      exprIsFunctionCallOf(rhsExpr, BuiltinKeywords.tuple)
    ) {
      // Tuple form: (Trait1, Trait2, ...)
      for (const traitExpr of rhsExpr.args) {
        if (
          exprIsFunctionCall(traitExpr) &&
          exprIsFunctionCallOf(traitExpr, "!") &&
          traitExpr.args.length === 1
        ) {
          traitExprs.push({ expr: traitExpr.args[0]!, isNegated: true });
        } else {
          traitExprs.push({ expr: traitExpr, isNegated: false });
        }
      }
    } else {
      // Single trait - check if negated
      if (
        exprIsFunctionCall(rhsExpr) &&
        exprIsFunctionCallOf(rhsExpr, "!") &&
        rhsExpr.args.length === 1
      ) {
        traitExprs.push({ expr: rhsExpr.args[0]!, isNegated: true });
      } else {
        traitExprs.push({ expr: rhsExpr, isNegated: false });
      }
    }

    // Evaluate each trait expression
    const requiredTraits: TraitType[] = [];
    const negativeTraits: TraitType[] = [];

    for (const { expr: traitExpr, isNegated } of traitExprs) {
      const evaluatedRhs = evaluateExpression({
        expr: traitExpr,
        env,
        context: { ...context },
      });
      if (
        !evaluatedRhs.$ ||
        !evaluatedRhs.$.value ||
        !isTypeValue(evaluatedRhs.$.value)
      ) {
        throw formatErrorMessage({
          token: traitExpr.token,
          errorMessage: `Expected trait type for right-hand side of where clause constraint.`,
        });
      }
      env = evaluatedRhs.$.env;

      const traitTypeValue = evaluatedRhs.$.value;
      if (!isTraitType(traitTypeValue.value)) {
        throw formatErrorMessage({
          token: traitExpr.token,
          errorMessage: `Expected trait type for right-hand side of where clause constraint, got: ${typeToString(traitTypeValue.value)}`,
        });
      }

      const traitType = traitTypeValue.value;
      if (traitType.receiverType) {
        throw formatErrorMessage({
          token: traitExpr.token,
          errorMessage: `Trait type in where clause already has a receiver type assigned.`,
        });
      }

      if (isNegated) {
        negativeTraits.push(traitType);
      } else {
        requiredTraits.push(traitType);
      }
    }

    // Store constraints for this SomeType
    const existing = whereClauseConstraints.get(someType);
    if (existing) {
      existing.requiredTraits.push(...requiredTraits);
      existing.negativeTraits.push(...negativeTraits);
    } else {
      whereClauseConstraints.set(someType, {
        requiredTraits,
        negativeTraits,
      });
    }
  }

  return { whereClauseConstraints, env };
}

/**
 * Helper function to validate constraints on a concrete type.
 */
function validateConcreteTypeConstraints({
  concreteType,
  rhsExpr,
  constraintExpr,
  env,
  context,
}: {
  concreteType: Type;
  rhsExpr: Expr;
  constraintExpr: Expr;
  env: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
}): Environment {
  // Parse RHS: can be Trait, (Trait1, Trait2), !(Trait), or (!(Trait1), Trait2)
  const traitExprs: { expr: Expr; isNegated: boolean }[] = [];
  if (
    exprIsFunctionCall(rhsExpr) &&
    exprIsFunctionCallOf(rhsExpr, BuiltinKeywords.tuple)
  ) {
    // Tuple form: (Trait1, Trait2, ...)
    for (const traitExpr of rhsExpr.args) {
      if (
        exprIsFunctionCall(traitExpr) &&
        exprIsFunctionCallOf(traitExpr, "!") &&
        traitExpr.args.length === 1
      ) {
        traitExprs.push({ expr: traitExpr.args[0]!, isNegated: true });
      } else {
        traitExprs.push({ expr: traitExpr, isNegated: false });
      }
    }
  } else {
    // Single trait - check if negated
    if (
      exprIsFunctionCall(rhsExpr) &&
      exprIsFunctionCallOf(rhsExpr, "!") &&
      rhsExpr.args.length === 1
    ) {
      traitExprs.push({ expr: rhsExpr.args[0]!, isNegated: true });
    } else {
      traitExprs.push({ expr: rhsExpr, isNegated: false });
    }
  }

  // Check each trait constraint
  for (const { expr: traitExpr, isNegated } of traitExprs) {
    const evaluatedTrait = evaluateExpression({
      expr: traitExpr,
      env,
      context: { ...context },
    });
    if (
      !evaluatedTrait.$ ||
      !evaluatedTrait.$.value ||
      !isTypeValue(evaluatedTrait.$.value)
    ) {
      throw formatErrorMessage({
        token: traitExpr.token,
        errorMessage: `Expected trait type for right-hand side of where clause constraint.`,
      });
    }
    env = evaluatedTrait.$.env;

    const traitTypeValue = evaluatedTrait.$.value;
    if (!isTraitType(traitTypeValue.value)) {
      throw formatErrorMessage({
        token: traitExpr.token,
        errorMessage: `Expected trait type for right-hand side of where clause constraint, got: ${typeToString(traitTypeValue.value)}`,
      });
    }

    const traitType = traitTypeValue.value;
    const implemented = typeImplementsTrait({
      targetType: concreteType,
      traitType,
      env,
    });

    if (isNegated) {
      // Negative constraint: type must NOT implement this trait
      if (implemented) {
        throw formatErrorMessage({
          token: constraintExpr.token,
          errorMessage: `Type ${typeToString(concreteType)} must NOT implement ${typeToString(traitType)}, but it does.`,
        });
      }
    } else {
      // Positive constraint: type must implement this trait
      if (!implemented) {
        throw formatErrorMessage({
          token: constraintExpr.token,
          errorMessage: `Type ${typeToString(concreteType)} does not implement required trait ${typeToString(traitType)}.`,
        });
      }
    }
  }

  return env;
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
  variadicParameter?: FunctionParameter;
  env: Environment;
  whereClauseConstraints?: Map<
    SomeType,
    {
      requiredTraits: TraitType[];
      negativeTraits: TraitType[];
    }
  >;
} {
  env = pushEnvFrame(env);

  const parameters: FunctionParameter[] = [];
  const forallParameters: FunctionParameter[] = [];
  let variadicParameter: FunctionParameter | undefined = undefined;
  let whereClauseConstraints:
    | Map<
        SomeType,
        {
          requiredTraits: TraitType[];
          negativeTraits: TraitType[];
        }
      >
    | undefined = undefined;

  let findVariadicParameter = false;

  // First pass: find and process forall parameters (creates SomeTypes)
  // forall must be the first parameter if present
  if (parameterExprs.length > 0) {
    const firstParam = parameterExprs[0]!;
    if (
      exprIsFunctionCall(firstParam) &&
      exprIsFunctionCallOf(firstParam, BuiltinKeywords.forall)
    ) {
      const typeParameterExprs = firstParam.args;

      for (let j = 0; j < typeParameterExprs.length; j++) {
        const typeParameterExpr = typeParameterExprs[j]!;
        const { parameter, env: nextEnv } = evaluateFunctionParameter({
          expr: typeParameterExpr,
          env,
          context: {
            ...context,
          },
          isParameterComptimeByDefault: true,
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
  }

  // Second pass: scan where clause, create SomeTypes for LHS vars, and try to evaluate constraints
  // where must be the last parameter if present
  let pendingConstraints: Expr[] = [];
  if (parameterExprs.length > 0) {
    const lastParam = parameterExprs[parameterExprs.length - 1]!;
    if (
      exprIsFunctionCall(lastParam) &&
      exprIsFunctionCallOf(lastParam, BuiltinKeywords.where)
    ) {
      const whereClauseExprs = lastParam.args;
      if (whereClauseExprs.length === 0) {
        throw formatErrorMessage({
          token: lastParam.token,
          errorMessage: `The where clause must have at least one constraint.`,
        });
      }

      // Try to evaluate constraints, store failed ones for retry
      const prepResult = prepareWhereClauseVariables({
        constraintExprs: whereClauseExprs,
        env,
        context,
      });
      env = prepResult.env;
      pendingConstraints = prepResult.pendingConstraints;
      whereClauseConstraints = prepResult.whereClauseConstraints;
    }
  }

  // Third pass: process regular parameters and variadic
  // After each parameter, retry pending constraints
  for (let i = 0; i < parameterExprs.length; i++) {
    const parameterExpr = parameterExprs[i]!;

    // Skip forall (already processed in first pass)
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
      continue;
    }
    // Skip where clause (already processed in second pass)
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
      continue;
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
            exprIsFunctionCallOf(argExpr, BuiltinKeywords.comptime)
          ) {
            isCompileTimeOnly = true;
            if (argExpr.args.length !== 1) {
              throw formatErrorMessage({
                token: argExpr.token,
                errorMessage: `Expected one argument for "comptime" , got ${argExpr.args.length}`,
              });
            }
            labelExpr = argExpr.args[0]!;
            parameterName = argExpr.args[0]!.token.value;

            // TODO: Set the parameterType to VaList
            parameterType = VUnit.type;

            throw formatErrorMessage({
              token: argExpr.token,
              errorMessage: `...(comptime(param_name)) is not supported yet.`,
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
        isOwningTheRcValue: false,
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
              ? [
                  createUnknownValue(parameterType, {
                    variableName: parameterName,
                    env,
                    context,
                  }),
                ]
              : undefined,
            token: labelExpr.token,
            initializedAtToken: labelExpr.token, // Set as initialized
            consumedAtToken: undefined, // Not consumed yet
            isOwningTheRcValue: variadicParameter.isOwningTheRcValue,
            isOwningTheSameRcValueAs: undefined, // Parameters don't borrow from other variables
            isReassignable: false, // Mark as not reassigable
          },
        });
        env = nextEnv;

        // Add the information to the labelExpr
        labelExpr.$ = {
          env,
          type: parameterType,
          value: isCompileTimeOnly
            ? createUnknownValue(parameterType, {
                variableName: parameterName,
                env,
                context,
              })
            : undefined,
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
        env,
        context: {
          ...context,
        },
        isParameterComptimeByDefault: false,
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

      // Retry pending constraints now that we have a new variable
      if (pendingConstraints.length > 0) {
        const retryResult = retryPendingConstraints({
          pendingConstraints,
          env,
          context,
          existingWhereClauseConstraints: whereClauseConstraints,
        });
        env = retryResult.env;
        pendingConstraints = retryResult.pendingConstraints;
        whereClauseConstraints = retryResult.whereClauseConstraints;
      }
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

  // Fourth pass: handle any remaining pending constraints
  // At this point all parameters should exist, so any remaining pending constraints indicate an error
  if (pendingConstraints.length > 0) {
    const retryResult = retryPendingConstraints({
      pendingConstraints,
      env,
      context,
      existingWhereClauseConstraints: whereClauseConstraints,
    });
    env = retryResult.env;
    whereClauseConstraints = retryResult.whereClauseConstraints;

    // If there are still pending constraints after final retry, throw the error
    if (retryResult.pendingConstraints.length > 0) {
      const failedConstraint = retryResult.pendingConstraints[0]!;
      // Evaluate to get the actual error message
      parseWhereClauseConstraints({
        constraintExprs: [failedConstraint],
        env,
        context,
      });
    }
  }

  return {
    parameters,
    forallParameters,
    variadicParameter,
    env,
    whereClauseConstraints,
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
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  // Only regular function types are supported with fn(...) -> ...
  // For closures, use Impl(Fn(...) -> ...) syntax instead
  if (!exprIsFunctionCallOf(expr, "->", 2)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected -> for function type, got:\n${exprToString(expr)}\n\nNote: For closures, use Impl(Fn(...) -> ...) syntax.`,
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

  // Evaluate the parameter list (where clauses will store constraints in expr.$)
  const {
    parameters,
    forallParameters,
    variadicParameter,
    env: nextEnv,
    whereClauseConstraints,
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
  /// -> (comptime(ret) : i32)
  /// -> (unquote(ret) : Expr)
  if (
    exprIsFunctionCall(returnExpr) &&
    exprIsFunctionCallOf(returnExpr, ":", 2)
  ) {
    let returnLabelExpr = returnExpr.args[0]!;
    returnTypeExpr = returnExpr.args[1]!;

    if (
      exprIsFunctionCall(returnLabelExpr) &&
      exprIsFunctionCallOf(returnLabelExpr, BuiltinKeywords.comptime)
    ) {
      isReturnTypeCompileTimeOnly = true;
      if (returnLabelExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: returnLabelExpr.token,
          errorMessage: `Expected one argument for "comptime" , got ${returnLabelExpr.args.length}`,
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
          errorMessage: `Cannot use "comptime"  with "unquote". "unquote" return type means compile-time only, so "comptime" is redundant.`,
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
  /// -> comptime(i32)
  /// -> unquote(Expr)
  else {
    if (
      exprIsFunctionCall(returnTypeExpr) &&
      exprIsFunctionCallOf(returnTypeExpr, BuiltinKeywords.comptime)
    ) {
      isReturnTypeCompileTimeOnly = true;
      if (returnTypeExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: returnTypeExpr.token,
          errorMessage: `Expected one argument for "comptime" , got ${returnTypeExpr.args.length}`,
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
          errorMessage: `Cannot use "comptime"  with "unquote". "unquote" return type means compile-time only, so "comptime" is redundant.`,
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

  if (
    typeRequiresComptimeModifier(returnType, env) &&
    !isReturnTypeCompileTimeOnly
  ) {
    // Try converting to runtime type first
    returnType = convertComptimeTypeToRuntimeType({
      type: returnType,
      expectedType: undefined,
      expr: undefined,
      env,
    });
    // If it still requires comptime modifier,
    // then throw an error
    if (typeRequiresComptimeModifier(returnType, env)) {
      throw formatErrorMessage({
        token: returnTypeExpr.token,
        errorMessage: `Expected a "comptime"  for return type, like:\n
comptime(${exprToString(returnTypeExpr)})

Given type:
${typeToString(returnType)}`,
      });
    }
  }

  // Prohibit the return type to be void
  if (!context.isUnsafeFunctionType) {
    prohibitVoidType(returnType, returnTypeExpr.token);
  }

  if (
    isReturnTypeCompileTimeOnly &&
    typeProhibitsComptimeModifier(returnType, env)
  ) {
    throw formatErrorMessage({
      token: returnTypeExpr.token,
      errorMessage: `Unexpected "comptime" for return type of ${typeToString(
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
  }

  // If the returnType is unquote, then
  // we need to make sure it's returning an Expr type
  if (isReturnTypeUnquote && !isExprType(returnType)) {
    throw formatErrorMessage({
      token: returnTypeExpr.token,
      errorMessage: `Expected Expr type for "unquote" return type, got ${typeToString(returnType)}`,
    });
  }

  // Create the function type
  const functionType = createFunctionType({
    parameters,
    forallParameters: forallParameters as FunctionForallParameter[],
    variadicParameter,
    return_: {
      type: returnType,
      expr: returnTypeExpr,
      isCompileTimeOnly: isReturnTypeCompileTimeOnly,
      isUnquote: isReturnTypeUnquote,
      label: returnLabel ?? `fn_return_${randomId(env.modulePath)}`,
    },
    env: popEnvFrame(env, true),
    parametersFrame: env.frames[env.frames.length - 1]!,
    SelfType: context.SelfType,
    ParentFunctionType:
      context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body"
        ? context.isEvaluatingFunctionBodyOrAsyncBlock.type
        : undefined,
  });

  // Attach where clause constraints collected from parameter evaluation
  if (whereClauseConstraints) {
    functionType.whereClauseConstraints = whereClauseConstraints;
  }

  // Pop the environment frame
  env = popEnvFrame(env, true);

  // Set the type and value of the expression
  expr.$ = {
    env,
    value: createTypeValue(functionType),
    type: typeOfType(functionType),
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

        isEvaluatingFunctionBodyOrAsyncBlock: functionType.ParentFunctionType
          ? {
              kind: "function-body",
              type: functionType.ParentFunctionType,
              evaluationEnv: calleeEnv,
              // QUESTION: Is this evaluationEnv correct?
              // QUESTION: Should we also set `value`?
            }
          : undefined,
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
    // Even without an expr, we still need to resolve SomeTypes in the return type
    // This is important for anonymous functions where return.expr is undefined
    let returnType = functionReturn.type;
    if (isSomeType(returnType)) {
      returnType = getValueOfSomeTypeFromEnv(calleeEnv, returnType);
    }
    return { returnType, calleeEnv };
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
