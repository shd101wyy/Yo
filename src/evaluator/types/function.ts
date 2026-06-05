import {
  addVariableToEnv,
  addWhereClauseConstraintToEnv,
  addWhereClauseConstraintForTypeApplication,
  type Environment,
  getVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { getDocCommentLookupKey } from "../../doc/extractor";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  cloneExpr,
  type Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import { PlaceholderToken, type Token } from "../../token";
import { areTypesCompatible } from "../../types/compatibility";
import {
  createComptimeListType,
  createExprListType,
  createFunctionType,
  createSomeType,
  createType0,
  getFunctionParameterExprs,
} from "../../types/creators";
import type {
  FunctionForallParameter,
  FunctionParameter,
  FunctionType,
  SomeType,
  Type,
} from "../../types/definitions";
import { getValueOfSomeTypeFromEnv } from "../../types/env-lookup";
import {
  isExprListType,
  isExprType,
  isFnTraitType,
  isFunctionType,
  isSomeType,
  isTraitType,
  isTypeApplicationType,
} from "../../types/guards";
import { getFunctionParameterToken, typeOfType } from "../../types/hierarchy";
import {
  convertComptimeTypeToRuntimeType,
  prohibitVoidType,
  typeContainsSomeType,
  typeProhibitsComptimeModifier,
  typeRequiresComptimeModifier,
  typeToString,
} from "../../types/utils";
import { VUnit } from "../../unit-value";
import { randomId } from "../../utils";
import {
  createTypeValue,
  createUnknownValue,
  isTypeValue,
  type Value,
  valueToString,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import {
  findSomeTypeMissingComptimeConstraint,
  typeImplementsTrait,
} from "../trait-checking";
import { isValidVariableName } from "../utils";

/**
 * Extract information about a comptime parameter from its expression.
 * Returns undefined if the parameter is not a comptime parameter.
 *
 * Handles forms like:
 *   - comptime(name) : Type
 *   - comptime(name) : Type ?= defaultValue
 */
function extractComptimeParameterInfo(
  paramExpr: Expr
): { name: string; typeExpr: Expr; token: Token } | undefined {
  let expr = paramExpr;

  // Handle default value: (comptime(name) : Type) ?= defaultValue
  if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, "?=", 2)) {
    expr = expr.args[0]!;
  }

  // Handle assigned value: (comptime(name) : Type) = value
  if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, "=", 2)) {
    expr = expr.args[0]!;
  }

  // Expect: comptime(name) : Type
  if (!exprIsFunctionCall(expr) || !exprIsFunctionCallOf(expr, ":", 2)) {
    return undefined;
  }

  const lhs = expr.args[0]!;
  const typeExpr = expr.args[1]!;

  // Check if lhs is comptime(name)
  if (
    !exprIsFunctionCall(lhs) ||
    !exprIsFunctionCallOf(lhs, BuiltinKeywords.comptime) ||
    lhs.args.length !== 1
  ) {
    return undefined;
  }

  const nameExpr = lhs.args[0]!;
  if (!exprIsAtom(nameExpr) || !isValidVariableName(nameExpr)) {
    return undefined;
  }

  return {
    name: nameExpr.token.value,
    typeExpr,
    token: nameExpr.token,
  };
}

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
  allowVariableShadowing,
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
  isParameterComptimeByDefault: boolean;
  allowVariableShadowing: boolean;
}): { parameter: FunctionParameter; env: Environment } {
  let label: string | undefined = undefined;
  let isCompileTimeOnly: boolean = isParameterComptimeByDefault;
  let isQuote: boolean = false;
  let isOwningTheRcValue: boolean = false;
  let isRef: boolean = false;

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
    // Assigned value syntax requires explicit type annotation: (T : Type) = Impl(Id)
    const lhs = expr_.args[0];
    if (lhs && exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":", 2)) {
      lhsExpr = lhs;
      rhsExpr = expr_.args[1]!;
      assignedValueExpr = rhsExpr;
      expr_ = lhsExpr; // Continue parsing the lhs for label and type
    } else {
      throw formatErrorMessage({
        token: expr_.func.token,
        errorMessage: `Use "?=" for default parameter values. Assigned values require an explicit type: (name : Type) = value.`,
      });
    }
  }

  // Disallow assignment binding with ":=" in parameter lists
  if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":=", 2)) {
    throw formatErrorMessage({
      token: expr_.func.token,
      errorMessage: `":=" is not allowed in parameter lists. Use (name : Type) = value instead.`,
    });
  }

  // Check if there is defaultValue
  // eg:
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
    // Only set typeExpr if it wasn't already set by assignment handling
    // eg:
    //   (i32)
    if (!defaultValueExpr) {
      typeExpr = expr_;
    }
    // eg:
    //   (x ?= 13)
    else {
      typeExpr = undefined;
      lhsExpr = expr_;
    }
  } else {
    // assignedValueExpr was set by assignment, expr_ is the label
    lhsExpr = expr_;
  }

  if (!typeExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: defaultValueExpr
        ? `Default parameters must specify a type: (name : Type) ?= value.`
        : `Expected an explicit type annotation for function parameter. Use "(name : Type)".`,
    });
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
      exprIsFunctionCallOf(lhsExpr, BuiltinKeywords.ref)
    ) {
      if (lhsExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `Expected one argument for "ref", got ${lhsExpr.args.length}`,
        });
      }
      if (isOwningTheRcValue) {
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `Cannot combine 'own' and 'ref' on the same parameter — they have opposite calling conventions.`,
        });
      }
      if (isParameterComptimeByDefault) {
        // forall/using params are erased at runtime; they have no callee-
        // side binding for ref to refer to. comptime(ref(...)) is
        // permitted (sets isCompileTimeOnly here), but forall(ref(...))
        // makes no sense.
        throw formatErrorMessage({
          token: lhsExpr.token,
          errorMessage: `'ref' cannot combine with 'forall'/'using' parameters — they are erased at runtime and have no callee-side binding to mutate.`,
        });
      }
      isRef = true;
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
    // Evaluate the assignedValueExpr if exists (for "=" syntax)
    // eg: forall((T : Type) = Impl(Id))
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
          errorMessage: `Expected type value for = assignment, got ${valueToString(assignedValue_)}`,
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
          errorMessage: `Assigned value (=) is only allowed for compile-time parameters. Use "comptime(${label})" or put this in "forall(...)".`,
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
      !typeContainsSomeType(parameterType) &&
      typeProhibitsComptimeModifier(parameterType, env)
    ) {
      throw formatErrorMessage({
        token: lhsExpr?.token ?? expr.token,
        errorMessage: `Parameter marked as "comptime" but type is not available at compile-time:
${typeToString(parameterType)}`,
      });
    }
    // When a comptime parameter type contains SomeTypes, validate that each
    // SomeType has a Comptime constraint. Skip during trait field evaluation.
    if (
      isCompileTimeOnly &&
      typeContainsSomeType(parameterType) &&
      !context.SelfTraitType
    ) {
      const missingSomeType = findSomeTypeMissingComptimeConstraint(
        parameterType,
        env
      );
      if (missingSomeType) {
        throw formatErrorMessage({
          token: lhsExpr?.token ?? expr.token,
          errorMessage: `Parameter type "${typeToString(
            parameterType
          )}" is used with "comptime" but type parameter "${typeToString(
            missingSomeType
          )}" does not implement the Comptime trait. Add "${missingSomeType.name} <: Comptime" to the where clause.`,
        });
      }
    }
    if (
      !isCompileTimeOnly &&
      typeRequiresComptimeModifier(parameterType, env) &&
      !isSomeType(parameterType) // Allow forall type variables (e : E where E : Type)
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
      // NOTE: Don't use isFunctionTypeGeneric/isFunctionSpecializable here. Too broad.
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
  // Check if the variable already exists (from where clause processing or pre-added comptime params)
  const existingVars = getVariablesFromEnv(env, label);
  const existingPreAddedVar =
    existingVars.length > 0 ? existingVars[existingVars.length - 1] : undefined;
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
    // Variable already exists from where clause - reuse it instead of creating new SomeType
    const existingTypeValue = existingWhereClauseVar.value![0] as Value & {
      value: SomeType;
    };
    const existingSomeType = existingTypeValue.value;

    // If there's an assigned value (from = syntax like Impl(Trait)), check if it adds new traits
    if (
      assignedValue &&
      isTypeValue(assignedValue) &&
      isSomeType(assignedValue.value)
    ) {
      const newSomeType = assignedValue.value;

      // Merge required traits from both SomeTypes
      const mergedRequiredTraits = [...existingSomeType.requiredTraits];
      for (const trait of newSomeType.requiredTraits) {
        if (
          !mergedRequiredTraits.some(
            (t) => t.traitType.id === trait.traitType.id
          )
        ) {
          mergedRequiredTraits.push(trait);
        }
      }

      // Merge negative traits
      const mergedNegativeTraits = [...(existingSomeType.negativeTraits ?? [])];
      if (newSomeType.negativeTraits) {
        for (const trait of newSomeType.negativeTraits) {
          if (
            !mergedNegativeTraits.some(
              (t) => t.traitType.id === trait.traitType.id
            )
          ) {
            mergedNegativeTraits.push(trait);
          }
        }
      }

      // Update the existing SomeType with merged traits
      existingSomeType.requiredTraits = mergedRequiredTraits;
      existingSomeType.negativeTraits = mergedNegativeTraits;
    }
    // Otherwise, just keep the existing SomeType; its where-clause constraints
    // are stored in the current env frame (this handles cases like
    // `comptime(T): Type` after `where(T <: Trait)`)

    // Use the existing SomeType as the actual value for this parameter
    actualValue = existingTypeValue;
    actualParameterType = typeOfType(existingSomeType);
  } else if (
    existingPreAddedVar &&
    existingPreAddedVar.isCompileTimeOnly &&
    existingPreAddedVar.value &&
    // Only reuse if the pre-added variable is in the current (top) frame.
    // Variables from outer frames (e.g., an outer function's using(io : Io))
    // must NOT be reused — we need to create a new variable in the current
    // parameters frame so it appears in parametersFrame for body evaluation.
    existingPreAddedVar.frameLevel === env.frames.length - 1
  ) {
    // Variable was pre-added by the comptime parameter pre-scan pass
    // Reuse it to avoid duplicate variable creation
    actualValue = existingPreAddedVar.value[0];
    actualParameterType = existingPreAddedVar.type;
  } else {
    // No existing variable - add new one
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: label,
        type: parameterType,
        isCompileTimeOnly: isCompileTimeOnly,
        value:
          // If there's an assignedValue (from = syntax), use it
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
        // inout(name) : T parameters are second-class references —
        // assignments inside the callee write through to the caller's
        // variable. Mark reassignable so `a = b;` inside the body
        // type-checks. Codegen lowers reads/writes through a T*.
        isReassignable: isRef,
        isRef: isRef || undefined,
        isParameter: true,
        docComment: lhsExpr
          ? context.docCommentLookup?.get(getDocCommentLookupKey(lhsExpr.token))
          : undefined,
      },
      allowVariableShadowing,
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
      isRef,
      assignedValue,
    },
    env,
  };
}

/**
 * Represents a pending trait constraint that failed to evaluate.
 * Tracks the LHS expression and the specific trait expression (which may be wrapped with !).
 */
interface PendingTraitConstraint {
  lhsExpr: Expr;
  traitExpr: Expr; // May be !(Trait) or just Trait
  originalConstraintExpr: Expr;
}

/**
 * First pass of where clause processing: scan LHS variables, create SomeTypes for them,
 * and try to evaluate constraints. If a specific trait fails (e.g., references undefined variables),
 * store only that trait for later retry while applying successful traits immediately.
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
  pendingConstraints: PendingTraitConstraint[];
} {
  const pendingConstraints: PendingTraitConstraint[] = [];

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
            isParameter: true,
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

    // Now try to evaluate the constraint, collecting any failed individual traits
    const result = parseWhereClauseConstraints({
      constraintExprs: [constraintExpr],
      env,
      context,
      collectPendingTraits: true,
    });
    env = result.env;
    pendingConstraints.push(...result.pendingTraits);
  }

  return { env, pendingConstraints };
}

/**
 * Retry pending trait constraints that previously failed.
 * Returns updated env and remaining pending constraints.
 */
function retryPendingConstraints({
  pendingConstraints,
  env,
  context,
}: {
  pendingConstraints: PendingTraitConstraint[];
  env: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
}): {
  env: Environment;
  pendingConstraints: PendingTraitConstraint[];
} {
  const stillPending: PendingTraitConstraint[] = [];

  for (const pending of pendingConstraints) {
    const result = applySingleTraitConstraint({
      lhsExpr: pending.lhsExpr,
      traitExpr: pending.traitExpr,
      originalConstraintExpr: pending.originalConstraintExpr,
      env,
      context,
    });
    env = result.env;
    if (!result.success) {
      stillPending.push(pending);
    }
  }

  return { env, pendingConstraints: stillPending };
}

/**
 * Helper function to validate a single trait constraint on a concrete type.
 * Returns success=true if the constraint was satisfied, false if evaluation failed (should be retried later).
 * Throws if the constraint is definitively violated.
 */
function validateSingleTraitOnConcreteType({
  concreteType,
  traitExpr,
  isNegated,
  constraintExpr,
  env,
  context,
}: {
  concreteType: Type;
  traitExpr: Expr;
  isNegated: boolean;
  constraintExpr: Expr;
  env: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
}): {
  env: Environment;
  success: boolean;
} {
  let evaluatedTrait: Expr;
  try {
    evaluatedTrait = evaluateExpression({
      expr: traitExpr,
      env,
      context: { ...context },
    });
  } catch {
    return { env, success: false };
  }

  if (
    !evaluatedTrait.$ ||
    !evaluatedTrait.$.value ||
    !isTypeValue(evaluatedTrait.$.value)
  ) {
    return { env, success: false };
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
  // Use the full typeImplementsTrait (not Bool) so that bindings produced
  // during trait satisfaction (e.g. synthesizing `A=i32` from
  // `F <: Fn(item:A)->B` against `fn(item:i32)->i32`) are propagated back
  // into the returned env.
  const { implemented, env: envAfterCheck } = typeImplementsTrait({
    targetType: concreteType,
    traitType,
    env,
  });

  if (isNegated) {
    if (implemented) {
      throw formatErrorMessage({
        token: constraintExpr.token,
        errorMessage: `Type ${typeToString(concreteType)} must NOT implement ${typeToString(traitType)}, but it does.`,
      });
    }
  } else {
    if (!implemented) {
      throw formatErrorMessage({
        token: constraintExpr.token,
        errorMessage: `Type ${typeToString(concreteType)} does not implement required trait ${typeToString(traitType)}.`,
      });
    }
  }

  return { env: envAfterCheck, success: true };
}

/**
 * Try to apply a single trait constraint to a SomeType.
 * Returns success=true if the trait was successfully applied, false if it failed (should be retried later).
 */
function applySingleTraitConstraint({
  lhsExpr,
  traitExpr,
  originalConstraintExpr,
  env,
  context,
}: {
  lhsExpr: Expr;
  traitExpr: Expr; // May be !(Trait) or just Trait
  originalConstraintExpr: Expr;
  env: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
}): {
  env: Environment;
  success: boolean;
} {
  // Check if the trait expression is negated
  let isNegated = false;
  let unwrappedTraitExpr = traitExpr;
  if (
    exprIsFunctionCall(traitExpr) &&
    exprIsFunctionCallOf(traitExpr, "!") &&
    traitExpr.args.length === 1
  ) {
    isNegated = true;
    unwrappedTraitExpr = traitExpr.args[0]!;
  }

  // Resolve the LHS to a SomeType
  let someType: SomeType;

  if (exprIsAtom(lhsExpr)) {
    const varName = lhsExpr.token.value;
    const existingVars = getVariablesFromEnv(env, varName);
    if (existingVars.length === 0) {
      return { env, success: false };
    }
    const existingVar = existingVars[existingVars.length - 1]!;
    if (
      existingVar.value &&
      isTypeValue(existingVar.value[0]) &&
      isSomeType(existingVar.value[0].value)
    ) {
      someType = existingVar.value[0].value as SomeType;
    } else if (existingVar.value && isTypeValue(existingVar.value[0])) {
      // It's a concrete type - validate constraint immediately
      try {
        const result = validateSingleTraitOnConcreteType({
          concreteType: existingVar.value[0].value as Type,
          traitExpr: unwrappedTraitExpr,
          isNegated,
          constraintExpr: originalConstraintExpr,
          env,
          context,
        });
        return result;
      } catch {
        return { env, success: false };
      }
    } else {
      return { env, success: false };
    }
  } else {
    // Evaluate the LHS expression
    let evaluatedLhs: Expr;
    try {
      evaluatedLhs = evaluateExpression({
        expr: lhsExpr,
        env,
        context: { ...context },
      });
    } catch {
      return { env, success: false };
    }

    if (
      !evaluatedLhs.$ ||
      !evaluatedLhs.$.value ||
      !isTypeValue(evaluatedLhs.$.value)
    ) {
      return { env, success: false };
    }
    env = evaluatedLhs.$.env;

    const lhsTypeValue = evaluatedLhs.$.value;
    if (!isSomeType(lhsTypeValue.value)) {
      // It's a concrete type - validate constraint immediately
      try {
        const result = validateSingleTraitOnConcreteType({
          concreteType: lhsTypeValue.value,
          traitExpr: unwrappedTraitExpr,
          isNegated,
          constraintExpr: originalConstraintExpr,
          env,
          context,
        });
        return result;
      } catch {
        return { env, success: false };
      }
    }

    someType = lhsTypeValue.value;
    // Keep constraints scoped to the current frame.
  }

  // Now try to evaluate the trait expression (unwrapped)
  let evaluatedRhs: Expr;
  try {
    evaluatedRhs = evaluateExpression({
      expr: unwrappedTraitExpr,
      env,
      context: { ...context },
    });
  } catch {
    return { env, success: false };
  }

  if (
    !evaluatedRhs.$ ||
    !evaluatedRhs.$.value ||
    !isTypeValue(evaluatedRhs.$.value)
  ) {
    return { env, success: false };
  }
  env = evaluatedRhs.$.env;

  const traitTypeValue = evaluatedRhs.$.value;
  if (!isTraitType(traitTypeValue.value)) {
    throw formatErrorMessage({
      token: unwrappedTraitExpr.token,
      errorMessage: `Expected trait type for right-hand side of where clause constraint, got: ${typeToString(traitTypeValue.value)}`,
    });
  }

  const traitType = traitTypeValue.value;
  if (traitType.receiverType) {
    throw formatErrorMessage({
      token: unwrappedTraitExpr.token,
      errorMessage: `Trait type in where clause already has a receiver type assigned.`,
    });
  }

  env = addWhereClauseConstraintToEnv({
    env,
    someType,
    traitType,
    isNegated,
  });

  return { env, success: true };
}

/**
 * Parse where clause constraints from constraint expressions.
 * Handles forms like: T <: Trait, T <: (Trait1, Trait2), T <: !(Trait)
 *
 * When collectPendingTraits is true, failed individual traits are collected
 * instead of throwing an error.
 *
 * Assumes all LHS variables already exist in env (either from forall, regular params, or prepareWhereClauseVariables).
 */
function parseWhereClauseConstraints({
  constraintExprs,
  env,
  context,
  collectPendingTraits = false,
}: {
  constraintExprs: Expr[];
  env: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
  collectPendingTraits?: boolean;
}): {
  env: Environment;
  pendingTraits: PendingTraitConstraint[];
} {
  const pendingTraits: PendingTraitConstraint[] = [];
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
            isParameter: true,
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
      // Evaluate the LHS expression (must be a SomeType or TypeApplication)
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

      // HKT: Check if LHS is a TypeApplication (e.g., F(A) in `where(F(A) <: Functor(F))`)
      if (isTypeApplicationType(lhsTypeValue.value)) {
        const typeApp = lhsTypeValue.value;

        // Parse and evaluate the RHS trait(s)
        const traitExprsForTypeApp: Expr[] = [];
        if (
          exprIsFunctionCall(rhsExpr) &&
          exprIsFunctionCallOf(rhsExpr, BuiltinKeywords.tuple)
        ) {
          traitExprsForTypeApp.push(...rhsExpr.args);
        } else {
          traitExprsForTypeApp.push(rhsExpr);
        }

        for (const traitExpr of traitExprsForTypeApp) {
          let isNegated = false;
          let unwrappedTraitExpr = traitExpr;
          if (
            exprIsFunctionCall(traitExpr) &&
            exprIsFunctionCallOf(traitExpr, "!") &&
            traitExpr.args.length === 1
          ) {
            isNegated = true;
            unwrappedTraitExpr = traitExpr.args[0]!;
          }

          let evaluatedRhs: Expr;
          try {
            evaluatedRhs = evaluateExpression({
              expr: unwrappedTraitExpr,
              env,
              context: { ...context },
            });
          } catch (error) {
            if (collectPendingTraits) {
              pendingTraits.push({
                lhsExpr,
                traitExpr,
                originalConstraintExpr: constraintExpr,
              });
              continue;
            }
            throw error;
          }

          if (
            !evaluatedRhs.$ ||
            !evaluatedRhs.$.value ||
            !isTypeValue(evaluatedRhs.$.value)
          ) {
            if (collectPendingTraits) {
              pendingTraits.push({
                lhsExpr,
                traitExpr,
                originalConstraintExpr: constraintExpr,
              });
              continue;
            }
            throw formatErrorMessage({
              token: unwrappedTraitExpr.token,
              errorMessage: `Expected trait type for right-hand side of where clause constraint.`,
            });
          }
          env = evaluatedRhs.$.env;

          const traitTypeValue = evaluatedRhs.$.value;
          if (!isTraitType(traitTypeValue.value)) {
            throw formatErrorMessage({
              token: unwrappedTraitExpr.token,
              errorMessage: `Expected trait type for right-hand side of where clause constraint, got: ${typeToString(traitTypeValue.value)}`,
            });
          }

          const traitType = traitTypeValue.value;
          env = addWhereClauseConstraintForTypeApplication({
            env,
            typeApp,
            traitType,
            isNegated,
          });
        }
        continue;
      }

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

      // Keep constraints scoped to the current frame.
    }

    // Parse RHS: can be Trait, (Trait1, Trait2), !(Trait), or (!(Trait1), Trait2)
    // Store the original expressions (potentially wrapped with !)
    const traitExprs: Expr[] = [];
    if (
      exprIsFunctionCall(rhsExpr) &&
      exprIsFunctionCallOf(rhsExpr, BuiltinKeywords.tuple)
    ) {
      // Tuple form: (Trait1, Trait2, ...)
      traitExprs.push(...rhsExpr.args);
    } else {
      // Single trait
      traitExprs.push(rhsExpr);
    }

    // Evaluate each trait expression and add constraints INCREMENTALLY
    // This is important for cases like `T <: (Comptime, ComptimeNegate(T))`
    // where the second trait depends on the first constraint being in scope
    for (let traitIdx = 0; traitIdx < traitExprs.length; traitIdx++) {
      const traitExpr = traitExprs[traitIdx]!;

      // Check if this trait is negated
      let isNegated = false;
      let unwrappedTraitExpr = traitExpr;
      if (
        exprIsFunctionCall(traitExpr) &&
        exprIsFunctionCallOf(traitExpr, "!") &&
        traitExpr.args.length === 1
      ) {
        isNegated = true;
        unwrappedTraitExpr = traitExpr.args[0]!;
      }

      // Try to evaluate the trait expression (unwrapped)
      let evaluatedRhs: Expr;
      try {
        evaluatedRhs = evaluateExpression({
          expr: unwrappedTraitExpr,
          env,
          context: { ...context },
        });
      } catch (error) {
        // Trait evaluation failed - collect for retry if requested
        if (collectPendingTraits) {
          pendingTraits.push({
            lhsExpr,
            traitExpr, // Store the original (potentially wrapped) expression
            originalConstraintExpr: constraintExpr,
          });
          continue;
        }
        throw error;
      }

      if (
        !evaluatedRhs.$ ||
        !evaluatedRhs.$.value ||
        !isTypeValue(evaluatedRhs.$.value)
      ) {
        if (collectPendingTraits) {
          pendingTraits.push({
            lhsExpr,
            traitExpr, // Store the original (potentially wrapped) expression
            originalConstraintExpr: constraintExpr,
          });
          continue;
        }
        throw formatErrorMessage({
          token: unwrappedTraitExpr.token,
          errorMessage: `Expected trait type for right-hand side of where clause constraint.`,
        });
      }
      env = evaluatedRhs.$.env;

      const traitTypeValue = evaluatedRhs.$.value;
      if (!isTraitType(traitTypeValue.value)) {
        throw formatErrorMessage({
          token: unwrappedTraitExpr.token,
          errorMessage: `Expected trait type for right-hand side of where clause constraint, got: ${typeToString(traitTypeValue.value)}`,
        });
      }

      const traitType = traitTypeValue.value;
      if (traitType.receiverType) {
        throw formatErrorMessage({
          token: unwrappedTraitExpr.token,
          errorMessage: `Trait type in where clause already has a receiver type assigned.`,
        });
      }

      env = addWhereClauseConstraintToEnv({
        env,
        someType,
        traitType,
        isNegated,
      });
    }
  }

  return { env, pendingTraits };
}

/**
 * Apply where-clause constraints in the current environment frame.
 * This is used when evaluating a function body to re-attach constraints
 * that were validated during function type evaluation.
 */
export function applyWhereClauseConstraints({
  constraintExprs,
  env,
  context,
}: {
  constraintExprs: Expr[];
  env: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
}): { env: Environment } {
  if (constraintExprs.length === 0) {
    return { env };
  }

  const result = parseWhereClauseConstraints({
    constraintExprs,
    env,
    context,
    collectPendingTraits: false,
  });

  return { env: result.env };
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
    const { implemented, env: envAfterCheck } = typeImplementsTrait({
      targetType: concreteType,
      traitType,
      env,
    });
    env = envAfterCheck;

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
  whereClauseExprs?: Expr[];
  requiresExprs?: Expr[];
  ensuresExprs?: Expr[];
  env: Environment;
} {
  env = pushEnvFrame(env);

  const parameters: FunctionParameter[] = [];
  const forallParameters: FunctionParameter[] = [];
  let variadicParameter: FunctionParameter | undefined = undefined;
  let whereClauseExprs: Expr[] | undefined = undefined;

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

        // `...(E)` effect-row variable declarations are gone — every
        // forall parameter is processed by the standard path below.

        const { parameter, env: nextEnv } = evaluateFunctionParameter({
          expr: typeParameterExpr,
          env,
          context: {
            ...context,
          },
          isParameterComptimeByDefault: true,
          allowVariableShadowing: true,
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

  // Phase 0 of plans/FORMAL_VERIFICATION.md: enforce the canonical
  // signature clause order. Each parameter belongs to an ordered
  // "zone"; zones must appear non-decreasing left-to-right:
  //   forall(0) → regular params (1) → where(2) → requires(3) → ensures(4)
  // A clause appearing before an earlier-zone clause is a syntax
  // error (e.g. `ensures(...)` before `requires(...)`, or `where(...)`
  // after `requires(...)`). This gives one canonical signature shape.
  {
    const zoneOf = (e: Expr): { zone: number; name: string } => {
      if (exprIsFunctionCall(e)) {
        if (exprIsFunctionCallOf(e, BuiltinKeywords.forall))
          return { zone: 0, name: "forall(...)" };
        if (exprIsFunctionCallOf(e, BuiltinKeywords.where))
          return { zone: 2, name: "where(...)" };
        if (exprIsFunctionCallOf(e, "requires"))
          return { zone: 3, name: "requires(...)" };
        if (exprIsFunctionCallOf(e, "ensures"))
          return { zone: 4, name: "ensures(...)" };
      }
      return { zone: 1, name: "parameter" };
    };
    const zoneLabels = [
      "forall(...)",
      "regular parameters",
      "where(...)",
      "requires(...)",
      "ensures(...)",
    ];
    let maxZone = 0;
    let maxName = "forall(...)";
    for (const paramExpr of parameterExprs) {
      const { zone, name } = zoneOf(paramExpr);
      if (zone < maxZone) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `${name} appears after ${maxName} in the function signature. The canonical clause order is: forall(...), parameters, where(...), requires(...), ensures(...). Move ${name} before ${zoneLabels[maxZone]!}.`,
        });
      }
      if (zone > maxZone) {
        maxZone = zone;
        maxName = name;
      }
    }
  }

  // Phase 0 of plans/FORMAL_VERIFICATION.md: extract `requires(...)`
  // and `ensures(...)` contract clauses from the parameter list. Each
  // builtin may appear at most once in a signature (single-call rule:
  // `requires(P1, P2, ...)` and `ensures(Q1, Q2, ...)`). Zero-argument
  // forms are rejected. The extracted predicates are stored on the
  // FunctionType and later (in Phase 0 task #6) lowered to runtime
  // `assert(...)` calls in default mode.
  let requiresExprs: Expr[] | undefined = undefined;
  let ensuresExprs: Expr[] | undefined = undefined;
  for (const paramExpr of parameterExprs) {
    if (!exprIsFunctionCall(paramExpr)) continue;
    if (exprIsFunctionCallOf(paramExpr, "requires")) {
      if (paramExpr.args.length === 0) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `'requires(...)' with zero arguments is a syntax error. Omit the clause entirely if there is no precondition.`,
        });
      }
      if (requiresExprs !== undefined) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `Multiple 'requires(...)' clauses in the same signature are a syntax error. Combine the predicates into one call: 'requires(P1, P2, ...)'.`,
        });
      }
      requiresExprs = paramExpr.args;
    } else if (exprIsFunctionCallOf(paramExpr, "ensures")) {
      if (paramExpr.args.length === 0) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `'ensures(...)' with zero arguments is a syntax error. Omit the clause entirely if there is no postcondition.`,
        });
      }
      if (ensuresExprs !== undefined) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `Multiple 'ensures(...)' clauses in the same signature are a syntax error. Combine the predicates into one call: 'ensures(Q1, Q2, ...)'.`,
        });
      }
      ensuresExprs = paramExpr.args;
    }
  }

  // Second pass: pre-add all comptime parameters to the environment
  // This is necessary because where clauses may reference comptime parameters that appear
  // later in the parameter list. For example:
  //   fn(comptime(Item) : Type, comptime(IntoIter) : Type, where(IntoIter <: Iterator(Item)))
  // The where clause references Item and IntoIter before they are fully processed.
  // Track which parameters were pre-added so we can skip them in the third pass
  const preAddedComptimeParams = new Set<number>();
  for (let i = 0; i < parameterExprs.length; i++) {
    const paramExpr = parameterExprs[i]!;
    // Skip forall, where, ..., and Phase-0 contract clauses
    // (requires/ensures). The contract clauses are recognized here so
    // they don't get treated as runtime parameters. Their bodies are
    // evaluated later — see plans/FORMAL_VERIFICATION.md task #4.
    if (
      exprIsFunctionCall(paramExpr) &&
      (exprIsFunctionCallOf(paramExpr, BuiltinKeywords.forall) ||
        exprIsFunctionCallOf(paramExpr, BuiltinKeywords.where) ||
        exprIsFunctionCallOf(paramExpr, "...") ||
        exprIsFunctionCallOf(paramExpr, "requires") ||
        exprIsFunctionCallOf(paramExpr, "ensures"))
    ) {
      continue;
    }
    // Check if this is a comptime parameter: comptime(name) : Type
    const comptimeInfo = extractComptimeParameterInfo(paramExpr);
    if (comptimeInfo) {
      // Evaluate the type expression
      const evaluatedType = evaluateExpression({
        expr: comptimeInfo.typeExpr,
        env,
        context: { ...context },
      });
      if (evaluatedType.$?.env) {
        env = evaluatedType.$.env;
      }
      if (
        !evaluatedType.$ ||
        !evaluatedType.$.value ||
        !isTypeValue(evaluatedType.$.value)
      ) {
        // Type evaluation failed, skip pre-adding - will be handled in third pass
        continue;
      }
      const paramType = evaluatedType.$.value.value;

      // Create the appropriate value (SomeType for Type, UnknownValue for others)
      const value = createUnknownValue(paramType, {
        variableName: comptimeInfo.name,
        env,
        context,
      });

      // Add to environment
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: comptimeInfo.name,
          type: paramType,
          isCompileTimeOnly: true,
          value: [value],
          token: comptimeInfo.token,
          initializedAtToken: comptimeInfo.token,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
          isOwningTheSameRcValueAs: undefined,
          isReassignable: false,
          isParameter: true,
        },
      });
      env = nextEnv;
      preAddedComptimeParams.add(i);
    }
  }

  // Third pass: scan where clause, create SomeTypes for LHS vars, and try to evaluate constraints
  // where must come at the end of the signature, but Phase-0 contract
  // clauses (requires/ensures) may follow it. Scan from the end past
  // any trailing contract clauses to find the where clause.
  let pendingConstraints: PendingTraitConstraint[] = [];
  if (parameterExprs.length > 0) {
    let whereIdx = parameterExprs.length - 1;
    while (whereIdx >= 0) {
      const candidate = parameterExprs[whereIdx]!;
      if (
        exprIsFunctionCall(candidate) &&
        (exprIsFunctionCallOf(candidate, "requires") ||
          exprIsFunctionCallOf(candidate, "ensures"))
      ) {
        whereIdx--;
        continue;
      }
      break;
    }
    const lastParam = whereIdx >= 0 ? parameterExprs[whereIdx]! : undefined;
    if (
      lastParam &&
      exprIsFunctionCall(lastParam) &&
      exprIsFunctionCallOf(lastParam, BuiltinKeywords.where)
    ) {
      whereClauseExprs = lastParam.args;
      if (whereClauseExprs.length === 0) {
        throw formatErrorMessage({
          token: lastParam.token,
          errorMessage: `The where clause must have at least one constraint.`,
        });
      }

      // Try to evaluate constraints, store failed ones for retry
      // Constraints are now stored directly on the SomeTypes
      const prepResult = prepareWhereClauseVariables({
        constraintExprs: whereClauseExprs,
        env,
        context,
      });
      env = prepResult.env;
      pendingConstraints = prepResult.pendingConstraints;
    }
  }

  // Fourth pass: process regular parameters and variadic
  // After each parameter, retry pending constraints
  // Note: parameters pre-added in second pass still need to be fully processed to create FunctionParameter objects
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
    // Skip where clause (already processed). Clause ordering —
    // including "where may only be followed by requires/ensures" — is
    // validated up front by the zone check at the top of this
    // function, so no positional check is needed here.
    else if (
      exprIsFunctionCall(parameterExpr) &&
      exprIsFunctionCallOf(parameterExpr, BuiltinKeywords.where)
    ) {
      continue;
    }
    // Skip Phase-0 contract clauses (requires/ensures). They were
    // recognized in the second pass; their bodies are not yet
    // extracted — see plans/FORMAL_VERIFICATION.md task #4.
    else if (
      exprIsFunctionCall(parameterExpr) &&
      (exprIsFunctionCallOf(parameterExpr, "requires") ||
        exprIsFunctionCallOf(parameterExpr, "ensures"))
    ) {
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
          // Type-annotated variadic: ...(something : Type)
          // Parser produces :(lhs, rhs) with 2 args
          if (
            exprIsFunctionCall(argExpr) &&
            exprIsFunctionCallOf(argExpr, BuiltinKeywords.quote) &&
            argExpr.args.length === 2
          ) {
            const lhsExpr_ = argExpr.args[0]!;
            const typeExprNode = argExpr.args[1]!;

            if (
              exprIsFunctionCall(lhsExpr_) &&
              exprIsFunctionCallOf(lhsExpr_, BuiltinKeywords.comptime)
            ) {
              // ...(comptime(name) : Type)
              isCompileTimeOnly = true;
              if (lhsExpr_.args.length !== 1) {
                throw formatErrorMessage({
                  token: lhsExpr_.token,
                  errorMessage: `Expected one argument for "comptime", got ${lhsExpr_.args.length}`,
                });
              }
              labelExpr = lhsExpr_.args[0]!;
              parameterName = lhsExpr_.args[0]!.token.value;
            } else if (
              exprIsFunctionCall(lhsExpr_) &&
              exprIsFunctionCallOf(lhsExpr_, BuiltinKeywords.quote)
            ) {
              // ...(:(name) : Type) — quote with explicit type
              isCompileTimeOnly = true;
              isQuote = true;
              if (lhsExpr_.args.length !== 1) {
                throw formatErrorMessage({
                  token: lhsExpr_.token,
                  errorMessage: `Expected one argument for "quote" (or ":"), got ${lhsExpr_.args.length}`,
                });
              }
              labelExpr = lhsExpr_.args[0]!;
              parameterName = lhsExpr_.args[0]!.token.value;
            } else if (exprIsAtom(lhsExpr_) && isValidVariableName(lhsExpr_)) {
              // ...(name : Type) — runtime variadic with type
              labelExpr = lhsExpr_;
              parameterName = lhsExpr_.token.value;
            } else {
              throw formatErrorMessage({
                token: lhsExpr_.token,
                errorMessage: `Expected a valid variable name for variadic parameter, got ${exprToString(lhsExpr_)}`,
              });
            }

            // Evaluate the type expression
            const evaluatedType = evaluateExpression({
              expr: typeExprNode,
              env,
              context: { ...context },
            });
            if (!evaluatedType.$) {
              throw formatErrorMessage({
                token: typeExprNode.token,
                errorMessage: `Failed to evaluate type expression: ${exprToString(typeExprNode)}`,
              });
            }
            env = evaluatedType.$.env;
            const typeValue = evaluatedType.$.value;
            if (isTypeValue(typeValue)) {
              parameterType = typeValue.value;
            } else {
              throw formatErrorMessage({
                token: typeExprNode.token,
                errorMessage: `Expected type for variadic parameter, got ${valueToString(typeValue)}`,
              });
            }
          }
          // ...(comptime(name)) without type annotation
          else if (
            exprIsFunctionCall(argExpr) &&
            exprIsFunctionCallOf(argExpr, BuiltinKeywords.comptime)
          ) {
            isCompileTimeOnly = true;
            if (argExpr.args.length !== 1) {
              throw formatErrorMessage({
                token: argExpr.token,
                errorMessage: `Expected one argument for "comptime", got ${argExpr.args.length}`,
              });
            }
            labelExpr = argExpr.args[0]!;
            parameterName = argExpr.args[0]!.token.value;

            // Default to ComptimeList(Type) — variadic comptime params are typically types
            parameterType = createComptimeListType(createType0());
          }
          // ...(quote(name)) or ...(:(name)) — macro/quote variadic (1 arg)
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

      const variadicTypeExpr = generateExprFromCode(
        typeToString(parameterType)
      );

      // Create the parameter object
      const createdVariadicParameter: FunctionParameter = {
        exprs: {
          expr: parameterExpr,
          labelExpr,
          typeExpr: variadicTypeExpr,
        },
        isCompileTimeOnly,
        isQuote,
        label: parameterName,
        type: parameterType,
        isOwningTheRcValue: false,
      };
      variadicParameter = createdVariadicParameter;

      if (parameterName !== "...") {
        // Add the parameter to the environment
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: parameterName,
            type: parameterType,
            isCompileTimeOnly: createdVariadicParameter.isCompileTimeOnly,
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
            isOwningTheRcValue: createdVariadicParameter.isOwningTheRcValue,
            isOwningTheSameRcValueAs: undefined, // Parameters don't borrow from other variables
            isReassignable: false, // Mark as not reassigable
            isParameter: true,
            docComment: context.docCommentLookup?.get(
              getDocCommentLookupKey(labelExpr.token)
            ),
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
        allowVariableShadowing: true,
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
        });
        env = retryResult.env;
        pendingConstraints = retryResult.pendingConstraints;
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
    });
    env = retryResult.env;

    // If there are still pending constraints after final retry, throw the error
    if (retryResult.pendingConstraints.length > 0) {
      const failedConstraint = retryResult.pendingConstraints[0]!;
      // Re-evaluate to get the actual error message
      // Use parseWhereClauseConstraints with collectPendingTraits=false to throw the error
      parseWhereClauseConstraints({
        constraintExprs: [failedConstraint.originalConstraintExpr],
        env,
        context,
        collectPendingTraits: false,
      });
    }
  }

  return {
    parameters,
    forallParameters,
    variadicParameter,
    whereClauseExprs,
    requiresExprs,
    ensuresExprs,
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

  // For both regular functions and closures, expect fn(...), ctl(...),
  // or unsafe_fn(...) syntax. `ctl` is the control-function type
  // constructor — parallel to `fn`, but its body may contain `unwind`
  // and the value is frame-bound (escape boundaries reject it).
  if (
    exprIsFunctionCall(argListExpr) &&
    (exprIsFunctionCallOf(argListExpr, BuiltinKeywords.fn) ||
      exprIsFunctionCallOf(argListExpr, BuiltinKeywords.ctl) ||
      exprIsFunctionCallOf(argListExpr, BuiltinKeywords.unsafe_fn))
  ) {
    argList = argListExpr.args;
  } else {
    throw formatErrorMessage({
      token: argListExpr.token,
      errorMessage: `Expected a "fn", "ctl", or "unsafe_fn" call for parameter list, got:\n${exprToString(argListExpr)}`,
    });
  }

  // Evaluate the parameter list (where clauses store constraints in env frames)
  const {
    parameters,
    forallParameters,
    variadicParameter,
    whereClauseExprs,
    requiresExprs,
    ensuresExprs,
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
  let isReturnTypeRef = false;
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
    // `(ref(name) : T)` — labeled-ref-return form. Mirrors the
    // parameter-side `ref(name) : T` shape so users don't have to
    // remember a different convention for return-slot labels.
    // Sets isReturnTypeRef just like `-> ref(T)` does at the
    // unlabeled path below (lines 2336+); the inner identifier
    // becomes the label.
    if (
      exprIsFunctionCall(returnLabelExpr) &&
      exprIsFunctionCallOf(returnLabelExpr, BuiltinKeywords.ref)
    ) {
      if (returnLabelExpr.args.length !== 1) {
        throw formatErrorMessage({
          token: returnLabelExpr.token,
          errorMessage: `Expected one argument for "ref" in return label, got ${returnLabelExpr.args.length}`,
        });
      }
      // Forbid `(ref(name) : ref(T))` — ref appears twice for the
      // same return slot. Pick one form, not both.
      if (
        exprIsFunctionCall(returnTypeExpr) &&
        exprIsFunctionCallOf(returnTypeExpr, BuiltinKeywords.ref)
      ) {
        throw formatErrorMessage({
          token: returnTypeExpr.token,
          errorMessage: `Cannot use 'ref' on both the label and the type of a return slot. Pick one: '-> (ref(name) : T)' or '-> (name : ref(T))'.`,
        });
      }
      if (isReturnTypeUnquote) {
        throw formatErrorMessage({
          token: returnLabelExpr.token,
          errorMessage: `Cannot combine 'unquote' with 'ref' in a return slot — macro return types are erased at runtime and have no place to put a borrow.`,
        });
      }
      isReturnTypeRef = true;
      returnLabelExpr = returnLabelExpr.args[0]!;
    }
    // In a labeled return slot, a `ref`/`comptime` modifier goes on the LABEL,
    // never on the TYPE. `-> (name : ref(T))` / `-> (name : comptime(T))` are
    // rejected; use `-> (ref(name) : T)` / `-> (comptime(name) : T)` (or the
    // unlabeled `-> ref(T)` / `-> comptime(T)`). This keeps return-slot labels
    // consistent with the parameter convention (`ref(name) : T`). The
    // `(ref(name) : ref(T))` double-ref case is caught above with a more
    // specific message.
    if (
      exprIsFunctionCall(returnTypeExpr) &&
      exprIsFunctionCallOf(returnTypeExpr, BuiltinKeywords.ref)
    ) {
      throw formatErrorMessage({
        token: returnTypeExpr.token,
        errorMessage: `In a labeled return slot, 'ref' goes on the label, not the type. Use '-> (ref(name) : T)' (or unlabeled '-> ref(T)'), not '-> (name : ref(T))'.`,
      });
    }
    if (
      exprIsFunctionCall(returnTypeExpr) &&
      exprIsFunctionCallOf(returnTypeExpr, BuiltinKeywords.comptime)
    ) {
      throw formatErrorMessage({
        token: returnTypeExpr.token,
        errorMessage: `In a labeled return slot, 'comptime' goes on the label, not the type. Use '-> (comptime(name) : T)' (or unlabeled '-> comptime(T)'), not '-> (name : comptime(T))'.`,
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

  // `ref(T)` in the return slot — Phase A of plans/ITERATOR_REDESIGN.md.
  // The function yields a second-class reference into storage rooted
  // in one of its `ref`-typed parameters; the C-ABI return is `T*`
  // and the call site receives a `ref`-bindable expression. We
  // unwrap `ref(...)` here to evaluate `T` as the underlying type,
  // and mark `isReturnTypeRef` so the function type carries the
  // distinction.
  //
  // `ref(T)` is only legal at the OUTERMOST position of a return
  // slot. The rule that bars it from appearing inside `Option(...)`,
  // generic args, struct fields, etc. is enforced by NOT recognizing
  // `ref(...)` anywhere else in the type evaluator — outside this
  // narrow spot, the evaluator falls through and tries to evaluate
  // `ref` as a regular identifier, producing a "Variable not found"
  // error. (We could add a more targeted diagnostic later; for v1
  // the structural impossibility is sufficient.)
  if (
    exprIsFunctionCall(returnTypeExpr) &&
    exprIsFunctionCallOf(returnTypeExpr, BuiltinKeywords.ref)
  ) {
    if (returnTypeExpr.args.length !== 1) {
      throw formatErrorMessage({
        token: returnTypeExpr.token,
        errorMessage: `Expected one argument for "ref" return slot, got ${returnTypeExpr.args.length}`,
      });
    }
    if (isReturnTypeUnquote) {
      throw formatErrorMessage({
        token: returnTypeExpr.token,
        errorMessage: `Cannot combine 'unquote' with 'ref' in a return slot — macro return types are erased at runtime and have no place to put a borrow.`,
      });
    }
    isReturnTypeRef = true;
    returnTypeExpr = returnTypeExpr.args[0]!;
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
    !typeContainsSomeType(returnType) &&
    typeProhibitsComptimeModifier(returnType, env)
  ) {
    throw formatErrorMessage({
      token: returnTypeExpr.token,
      errorMessage: `Unexpected "comptime" for return type of ${typeToString(
        returnType
      )} which can only be used at runtime.`,
    });
  }

  // When the return type is comptime and contains SomeTypes, validate that
  // each SomeType has a Comptime constraint. Skip during trait field evaluation
  // because trait where-clause constraints (e.g., Self.Output <: Comptime) may
  // not be applied yet — trait.ts validates after all constraints are resolved.
  if (
    isReturnTypeCompileTimeOnly &&
    typeContainsSomeType(returnType) &&
    !context.SelfTraitType
  ) {
    const missingSomeType = findSomeTypeMissingComptimeConstraint(
      returnType,
      env
    );
    if (missingSomeType) {
      throw formatErrorMessage({
        token: returnTypeExpr.token,
        errorMessage: `Return type "${typeToString(
          returnType
        )}" is used with "comptime" but type parameter "${typeToString(
          missingSomeType
        )}" does not implement the Comptime trait. Add "${missingSomeType.name} <: Comptime" to the where clause.`,
      });
    }
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
    whereClauseExprs,
    requiresExprs,
    ensuresExprs,
    return_: {
      type: returnType,
      typeExpr: returnTypeExpr,
      isCompileTimeOnly: isReturnTypeCompileTimeOnly,
      isUnquote: isReturnTypeUnquote,
      label: returnLabel ?? `fn_return_${randomId(env.modulePath)}`,
      isRef: isReturnTypeRef || undefined,
    },
    env: popEnvFrame(env, true),
    parametersFrame: env.frames[env.frames.length - 1]!,
    SelfType: context.SelfType,
    SelfTraitType: context.SelfTraitType,
    isControl: context.isControlFunctionType,
  });

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
  definitionSiteEnclosingFunctionType,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  functionType,
}: {
  parameter: FunctionParameter;
  calleeEnv: Environment;
  context: EvaluatorContext & { isEvaluatingFunctionType: true };
  definitionSiteEnclosingFunctionType?: FunctionType;
  functionType: FunctionType;
}): { parameterType: Type; calleeEnv: Environment } {
  const typeExpr = parameter.exprs.typeExpr;
  const defaultValueExpr = parameter.exprs.defaultValueExpr;
  if (typeExpr) {
    const recurEnclosingFunctionType =
      definitionSiteEnclosingFunctionType ??
      (context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body"
        ? context.isEvaluatingFunctionBodyOrAsyncBlock.type
        : undefined);

    const evaluatedTypeExpr = evaluateExpression({
      expr: cloneExpr(typeExpr),
      env: calleeEnv,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: functionType.SelfType,
        SelfTraitType: functionType.SelfTraitType ?? context.SelfTraitType,

        isEvaluatingFunctionBodyOrAsyncBlock: recurEnclosingFunctionType
          ? {
              kind: "function-body",
              type: recurEnclosingFunctionType,
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
        SelfTraitType: functionType.SelfTraitType ?? context.SelfTraitType,
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

  const evaluatedFunctionReturnExpr = evaluateExpression({
    expr: cloneExpr(functionReturn.typeExpr),
    env: calleeEnv,
    context: {
      ...context,
      SelfType: functionType.SelfType,
      SelfTraitType: functionType.SelfTraitType ?? context.SelfTraitType,
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
