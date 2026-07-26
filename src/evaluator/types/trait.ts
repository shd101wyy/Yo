import {
  addVariableToEnv,
  addWhereClauseConstraintToEnv,
  type Environment,
  getVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { getDocCommentLookupKey } from "../../doc/extractor";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import {
  createSomeType,
  createTraitType,
  createType0,
} from "../../types/creators";
import type {
  SomeType,
  TraitField,
  TraitType,
  Type,
} from "../../types/definitions";
import { getTraitTypeFromEnv } from "../../types/env-lookup";
import {
  isFunctionType,
  isSomeType,
  isTraitType,
  isTypeHierarchyType,
} from "../../types/guards";
import { typeOfType } from "../../types/hierarchy";
import { typeContainsSomeType, typeToString } from "../../types/utils";
import { VUnit } from "../../unit-value";
import { randomId } from "../../utils";
import {
  createTypeValue,
  createUnknownValue,
  isTypeValue,
  type Value,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { findSomeTypeMissingComptimeConstraint } from "../trait-checking";
import { isValidVariableName } from "../utils";
import { attachTraitToReceiverType } from "./utils";

/**
 * Represents a pending trait constraint that failed to evaluate.
 * Tracks the LHS expression and the specific trait expression (which may be wrapped with !).
 */
interface PendingTraitConstraint {
  lhsExpr: Expr;
  traitExpr: Expr; // May be !(Trait) or just Trait
  originalConstraintExpr: Expr;
}

function getOrCreateSomeTypeForTraitWhereClause({
  lhsExpr,
  env,
  context,
  selfType,
}: {
  lhsExpr: Expr;
  env: Environment;
  context: EvaluatorContext;
  selfType: SomeType;
}): { env: Environment; someType: SomeType; isSelf: boolean } {
  if (exprIsAtom(lhsExpr) && lhsExpr.token.value === "Self") {
    return { env, someType: selfType, isSelf: true };
  }

  if (exprIsAtom(lhsExpr)) {
    const varName = lhsExpr.token.value;
    const existingVars = getVariablesFromEnv(env, varName);
    if (existingVars.length > 0) {
      const existingVar = existingVars[existingVars.length - 1]!;
      if (
        existingVar.value &&
        isTypeValue(existingVar.value[0]) &&
        isSomeType(existingVar.value[0].value)
      ) {
        return {
          env,
          someType: existingVar.value[0].value as SomeType,
          isSelf: false,
        };
      }
    }

    // Create a new SomeType if not found
    const someType = createSomeType(createType0(), varName, { env, context });
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
      allowVariableShadowing: true,
    });
    return { env: nextEnv, someType, isSelf: false };
  }

  // Evaluate the LHS expression (must resolve to SomeType)
  const evaluatedLhs = evaluateExpression({
    expr: lhsExpr,
    env,
    context: { ...context, SelfType: selfType },
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
  const lhsTypeValue = evaluatedLhs.$.value;
  if (!isSomeType(lhsTypeValue.value)) {
    throw formatErrorMessage({
      token: lhsExpr.token,
      errorMessage: `Expected SomeType for left-hand side of where clause constraint, got ${typeToString(lhsTypeValue.value)}`,
    });
  }

  return {
    env: evaluatedLhs.$.env,
    someType: lhsTypeValue.value,
    isSelf: false,
  };
}

function applySingleTraitConstraintForTrait({
  lhsExpr,
  traitExpr,
  env,
  context,
  selfType,
  traitType,
}: {
  lhsExpr: Expr;
  traitExpr: Expr; // May be !(Trait) or just Trait
  originalConstraintExpr: Expr;
  env: Environment;
  context: EvaluatorContext;
  selfType: SomeType;
  traitType: TraitType;
}): { env: Environment; success: boolean } {
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

  let resolved;
  try {
    resolved = getOrCreateSomeTypeForTraitWhereClause({
      lhsExpr,
      env,
      context,
      selfType,
    });
  } catch {
    return { env, success: false };
  }
  env = resolved.env;

  // Try to evaluate the trait expression
  let evaluatedRhs: Expr;
  try {
    evaluatedRhs = evaluateExpression({
      expr: unwrappedTraitExpr,
      env,
      context: { ...context, SelfType: selfType },
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

  const evaluatedTraitTypeValue = evaluatedRhs.$.value;
  if (!isTraitType(evaluatedTraitTypeValue.value)) {
    throw formatErrorMessage({
      token: unwrappedTraitExpr.token,
      errorMessage: `Expected trait type for right-hand side of where clause constraint, got: ${typeToString(evaluatedTraitTypeValue.value)}`,
    });
  }

  const constraintTraitType = evaluatedTraitTypeValue.value;
  if (constraintTraitType.receiverType) {
    throw formatErrorMessage({
      token: unwrappedTraitExpr.token,
      errorMessage: `Trait type in where clause already has a receiver type assigned.`,
    });
  }

  if (resolved.isSelf) {
    // Record Self constraints on the trait type
    if (!traitType.selfConstraints) {
      traitType.selfConstraints = [];
    }
    if (!traitType.negativeSelfConstraints) {
      traitType.negativeSelfConstraints = [];
    }

    if (isNegated) {
      traitType.negativeSelfConstraints.push(constraintTraitType);
    } else {
      traitType.selfConstraints.push(constraintTraitType);
    }
  }

  // Also persist the constraint directly on the SomeType's requiredTraits/negativeTraits.
  // This is needed because the env frame is popped after trait evaluation,
  // but the constraint must be accessible when checking impl where clauses.
  if (!resolved.isSelf) {
    const currentFrameLevel = env.frames.length - 1;
    if (isNegated) {
      if (
        !resolved.someType.negativeTraits.some(
          (t) => t.traitType.id === constraintTraitType.id
        )
      ) {
        resolved.someType.negativeTraits.push({
          traitType: constraintTraitType,
          frameLevel: currentFrameLevel,
        });
      }
    } else {
      if (
        !resolved.someType.requiredTraits.some(
          (t) => t.traitType.id === constraintTraitType.id
        )
      ) {
        resolved.someType.requiredTraits.push({
          traitType: constraintTraitType,
          frameLevel: currentFrameLevel,
        });
      }
    }
  }

  env = addWhereClauseConstraintToEnv({
    env,
    someType: resolved.someType,
    traitType: constraintTraitType,
    isNegated,
  });

  return { env, success: true };
}

function parseTraitWhereClauseConstraints({
  constraintExprs,
  env,
  context,
  selfType,
  traitType,
  collectPendingTraits = false,
}: {
  constraintExprs: Expr[];
  env: Environment;
  context: EvaluatorContext;
  selfType: SomeType;
  traitType: TraitType;
  collectPendingTraits?: boolean;
}): { env: Environment; pendingTraits: PendingTraitConstraint[] } {
  const pendingTraits: PendingTraitConstraint[] = [];

  for (const constraintExpr of constraintExprs) {
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

    let resolved;
    try {
      resolved = getOrCreateSomeTypeForTraitWhereClause({
        lhsExpr,
        env,
        context,
        selfType,
      });
    } catch {
      if (collectPendingTraits) {
        // LHS may reference an associated type not yet defined.
        // Collect as pending and retry after all fields are processed.
        pendingTraits.push({
          lhsExpr,
          traitExpr: rhsExpr,
          originalConstraintExpr: constraintExpr,
        });
        continue;
      }
      throw formatErrorMessage({
        token: lhsExpr.token,
        errorMessage: `Expected type for left-hand side of where clause constraint.`,
      });
    }
    env = resolved.env;

    const traitExprs: Expr[] = [];
    if (
      exprIsFunctionCall(rhsExpr) &&
      exprIsFunctionCallOf(rhsExpr, BuiltinKeywords.tuple)
    ) {
      traitExprs.push(...rhsExpr.args);
    } else {
      traitExprs.push(rhsExpr);
    }

    for (const traitExpr of traitExprs) {
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
          context: { ...context, SelfType: selfType, SelfTraitType: traitType },
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

      const evaluatedTraitTypeValue = evaluatedRhs.$.value;
      if (!isTraitType(evaluatedTraitTypeValue.value)) {
        throw formatErrorMessage({
          token: unwrappedTraitExpr.token,
          errorMessage: `Expected trait type for right-hand side of where clause constraint, got: ${typeToString(evaluatedTraitTypeValue.value)}`,
        });
      }

      const constraintTraitType = evaluatedTraitTypeValue.value;
      if (constraintTraitType.receiverType) {
        throw formatErrorMessage({
          token: unwrappedTraitExpr.token,
          errorMessage: `Trait type in where clause already has a receiver type assigned.`,
        });
      }

      if (resolved.isSelf) {
        if (!traitType.selfConstraints) {
          traitType.selfConstraints = [];
        }
        if (!traitType.negativeSelfConstraints) {
          traitType.negativeSelfConstraints = [];
        }

        if (isNegated) {
          traitType.negativeSelfConstraints.push(constraintTraitType);
        } else {
          traitType.selfConstraints.push(constraintTraitType);
        }
      }

      env = addWhereClauseConstraintToEnv({
        env,
        someType: resolved.someType,
        traitType: constraintTraitType,
        isNegated,
      });
    }
  }

  return { env, pendingTraits };
}

/**
 * Evaluate the field in trait rvalue
 *
 * type:
 * (x: i32) in trait(x: i32, ...)
 *
 * All fields in trait are compile-time only by default.
 */
export function evaluateTraitField({
  expr,
  traitFieldIndex,
  env,
  context,
  isForEvaluatingTraitType,
}: {
  expr: Expr;
  traitFieldIndex: number;
  env: Environment;
  context: EvaluatorContext;
  isForEvaluatingTraitType: boolean;
}): { field: TraitField; env: Environment } {
  let label: string | undefined = undefined;
  let expr_ = expr;

  let labelExpr: Expr | undefined = undefined;
  let typeExpr: Expr | undefined = undefined;

  let defaultValueExpr: Expr | undefined = undefined;
  let defaultValue: Value | undefined = undefined;

  let assignedValueExpr: Expr | undefined = undefined;
  let assignedValue: Value | undefined = undefined;

  let fieldType: Type | undefined = undefined;

  // Check the default value
  if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, "?=", 2)) {
    defaultValueExpr = expr.args[1]!;
    expr_ = expr.args[0]!;
  }

  // Check the assigned value
  if (
    exprIsFunctionCall(expr_) &&
    (exprIsFunctionCallOf(expr_, "=", 2) ||
      exprIsFunctionCallOf(expr_, "::", 2) ||
      exprIsFunctionCallOf(expr_, ":=", 2))
  ) {
    if (exprIsFunctionCallOf(expr_, "::", 2)) {
      throw formatErrorMessage({
        token: expr_.token,
        errorMessage: `Cannot use "::" for trait field. Use ":=" instead.
All trait fields are compile-time only by default.`,
      });
    }

    assignedValueExpr = expr_.args[1]!;
    expr_ = expr_.args[0]!;
  }

  // Cannot have both defaultValueExpr and assignedValueExpr
  if (defaultValueExpr && assignedValueExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Cannot have both default value and required value for trait field.`,
    });
  }

  // Parse the lhs expr (skip if we already got label from using(name) syntax)
  if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":", 2)) {
    labelExpr = expr_.args[0]!;
    typeExpr = expr_.args[1]!;

    // Check if it's compile-time only
    if (
      exprIsFunctionCall(labelExpr) &&
      exprIsFunctionCallOf(labelExpr, BuiltinKeywords.comptime, 1)
    ) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `No need to use "comptime" modifier. All trait fields are compile-time only by default.`,
      });
    }

    if (!exprIsAtom(labelExpr) && !isValidVariableName(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for tuple field label, got ${exprToString(labelExpr)}`,
      });
    }
    label = labelExpr.token.value;
  } else if (
    exprIsFunctionCall(expr_) &&
    exprIsFunctionCallOf(expr_, BuiltinKeywords.comptime, 1)
  ) {
    throw formatErrorMessage({
      token: expr_.token,
      errorMessage: `No need to use "comptime" modifier. All trait fields are compile-time only by default.`,
    });
  } else if (!defaultValueExpr && !assignedValueExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected label for trait field, got ${exprToString(expr_)}`,
    });
  } else {
    //  eg:
    //    Output ?= Self
    labelExpr = expr_;

    if (!isValidVariableName(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for trait field label, got ${exprToString(labelExpr)}`,
      });
    }
    if (!exprIsAtom(labelExpr) && !isValidVariableName(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for trait field label, got ${exprToString(labelExpr)}`,
      });
    }
    label = labelExpr.token.value;
  }

  // Check expectedType
  const expectedType = context.expectedType?.type;
  let expectedTraitFieldType: Type | undefined = undefined;
  if (expectedType) {
    if (isTraitType(expectedType)) {
      const traitField = expectedType.fields[traitFieldIndex];
      if (!traitField) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to get the field at index ${traitFieldIndex}`,
        });
      }

      expectedTraitFieldType = traitField.type;
    } else {
      /*
        throw formatErrorMessage(
          expr.token,
          `(1) Failed to evaluate the tuple fields. Expected type to be:
${typeToString(expectedType)}`
        );
        */
      // NOTE: Don't throw error here
    }
  }

  // Parse the type expr
  if (typeExpr) {
    const evaluatedTypeExpr = evaluateExpression({
      expr: typeExpr,
      env,
      context: {
        ...context,
        expectedType: expectedTraitFieldType
          ? {
              type: expectedTraitFieldType,
              env,
            }
          : undefined,
      },
    });
    if (evaluatedTypeExpr.$?.env) {
      env = evaluatedTypeExpr.$?.env;
    }

    // Expected the evaluatedTypeExpr to be a type
    const typeValue = evaluatedTypeExpr.$?.value;
    if (!isTypeValue(typeValue)) {
      throw formatErrorMessage({
        token: typeExpr.token,
        errorMessage: `Expected type for trait field, got ${exprToString(typeExpr)}`,
      });
    }
    fieldType = typeValue.value;
  }

  // Evaluate assignedValueExpr if it exists
  if (assignedValueExpr) {
    const fieldExpectedType = fieldType
      ? { type: fieldType, env }
      : expectedTraitFieldType
        ? {
            type: expectedTraitFieldType,
            env,
          }
        : undefined;
    const evaluatedAssignedValueExpr = evaluateExpression({
      expr: assignedValueExpr,
      env,
      context: {
        ...context,
        expectedType: fieldExpectedType,
      },
    });
    if (!evaluatedAssignedValueExpr.$) {
      throw formatErrorMessage({
        token: assignedValueExpr.token,
        errorMessage: `Failed to evaluate required value expression: ${exprToString(
          assignedValueExpr
        )}`,
      });
    }
    env = evaluatedAssignedValueExpr.$?.env;

    assignedValue = evaluatedAssignedValueExpr.$.value;
    if (!assignedValue) {
      throw formatErrorMessage({
        token: assignedValueExpr.token,
        errorMessage: `Expected compile-time known value for required value, got ${exprToString(
          assignedValueExpr
        )}`,
      });
    }

    const assignedValueType = evaluatedAssignedValueExpr.$.type;

    // Check if assignedValueType matches fieldExpectedType
    if (fieldExpectedType) {
      if (
        !areTypesCompatible(
          { type: fieldExpectedType.type, env },
          { type: assignedValueType, env }
        )
      ) {
        throw formatErrorMessage({
          token: assignedValueExpr.token,
          errorMessage: `Assigned value type mismatch:
Expected type: ${typeToString(fieldExpectedType.type)}
Given type: ${typeToString(assignedValueType)}`,
        });
      }
      fieldType = fieldExpectedType.type;
    } else {
      fieldType = assignedValueType;
    }
  }

  // Evaluate defaultValueExpr if it exists
  if (defaultValueExpr) {
    const fieldExpectedType = fieldType
      ? { type: fieldType, env }
      : expectedTraitFieldType
        ? {
            type: expectedTraitFieldType,
            env,
          }
        : undefined;
    const evaluatedDefaultValueExpr = evaluateExpression({
      expr: defaultValueExpr,
      env,
      context: {
        ...context,
        expectedType: fieldExpectedType,
      },
    });
    if (!evaluatedDefaultValueExpr.$) {
      throw formatErrorMessage({
        token: defaultValueExpr.token,
        errorMessage: `Failed to evaluate default value expression: ${exprToString(
          defaultValueExpr
        )}`,
      });
    }
    env = evaluatedDefaultValueExpr.$.env;

    defaultValue = evaluatedDefaultValueExpr.$?.value;
    if (!defaultValue) {
      throw formatErrorMessage({
        token: defaultValueExpr.token,
        errorMessage: `Expected compile-time known value for default value, got ${exprToString(
          defaultValueExpr
        )}`,
      });
    }

    const defaultValueType = evaluatedDefaultValueExpr.$.type;

    // Check if defaultValueType matches fieldExpectedType
    if (fieldExpectedType) {
      if (
        !areTypesCompatible(
          { type: fieldExpectedType.type, env },
          { type: defaultValueType, env }
        )
      ) {
        throw formatErrorMessage({
          token: defaultValueExpr.token,
          errorMessage: `Default value type mismatch:
Expected type: ${typeToString(fieldExpectedType.type)}
Given type: ${typeToString(defaultValueType)}`,
        });
      }
      fieldType = fieldExpectedType.type;
    } else {
      fieldType = defaultValueType;
    }
  }

  if (!fieldType) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Failed to infer the field type`,
    });
  }

  // Validate that function type parameters have typeExpr for re-evaluation support
  // This is required because we re-evaluate type expressions instead of substituting types
  // for nominal types like Option(T) to get correct funcIds
  if (isForEvaluatingTraitType && isFunctionType(fieldType)) {
    if (fieldType.variadicParameter) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Variadic function parameters are not allowed in trait field "${label ?? "unnamed"}".
Type expressions are required for all function parameters in trait fields to support proper type specialization.`,
      });
    }
    for (const param of fieldType.forallParameters) {
      if (!param.exprs.typeExpr) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Function generic parameter "${param.label}" in trait field "${label ?? "unnamed"}" must have an explicit type annotation.
Type expressions are required for all function parameters in trait fields to support proper type specialization.`,
        });
      }
    }
    for (const param of fieldType.parameters) {
      if (!param.exprs.typeExpr) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Function parameter "${param.label}" in trait field "${label ?? "unnamed"}" must have an explicit type annotation.
Type expressions are required for all function parameters in trait fields to support proper type specialization.`,
        });
      }
    }
    // Also validate return type has typeExpr
    if (!fieldType.return.typeExpr) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Function in trait field "${label ?? "unnamed"}" must have an explicit return type annotation.
Type expressions are required for return types in trait fields to support proper type specialization.`,
      });
    }
  }

  // Validate default value expression restrictions
  if (isForEvaluatingTraitType && defaultValueExpr) {
    if (!isFunctionType(fieldType)) {
      throw formatErrorMessage({
        token: defaultValueExpr.token,
        errorMessage: `Default values (?=) are only allowed for function type trait elements (excluding closures).
Trait field "${label ?? "unnamed"}" has type: ${typeToString(fieldType)}

To avoid circular dependency issues, please explicitly provide the value for this field.`,
      });
    }
  }

  if (labelExpr) {
    labelExpr.$ = {
      env,
      type: fieldType,
      value:
        assignedValue ??
        createUnknownValue(fieldType, { variableName: label, env, context }),
      pathCollection: [],
    };
  }

  if (expr !== typeExpr) {
    expr.$ = {
      env,
      value: VUnit,
      type: VUnit.type,
      pathCollection: [],
    };
  }

  // For associated types (fields declared as `X : Type` without an assigned value),
  // create a SomeType placeholder that represents the associated type.
  // This SomeType will be used when accessing Self.X in the trait definition.
  let unassignedSomeType: SomeType | undefined = undefined;
  if (
    isForEvaluatingTraitType &&
    !assignedValue &&
    isTypeHierarchyType(fieldType) &&
    fieldType.level === 0
  ) {
    if (label) {
      const existingVars = getVariablesFromEnv(env, label);
      const existingVar = existingVars[existingVars.length - 1];
      if (
        existingVar?.value &&
        isTypeValue(existingVar.value[0]) &&
        isSomeType(existingVar.value[0].value)
      ) {
        unassignedSomeType = existingVar.value[0].value as SomeType;
      }
    }

    if (!unassignedSomeType) {
      unassignedSomeType = createSomeType(
        fieldType,
        label ?? `__associated_type_${randomId(env.modulePath)}`,
        { env, context }
      );
    }
  }

  return {
    field: {
      label: label ?? `__field_${randomId(env.modulePath)}`,
      type: fieldType,
      exprs: {
        expr,
        labelExpr,
        typeExpr,
        defaultValueExpr,
        assignedValueExpr,
      },
      defaultValue,
      assignedValue,
      unassignedSomeType,
      docComment: labelExpr
        ? context.docCommentLookup?.get(getDocCommentLookupKey(labelExpr.token))
        : undefined,
    },
    env,
  };
}

export function evaluateTraitType({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.trait)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "trait", got:\n${exprToString(expr)}`,
    });
  }

  // Create traitType with empty fields
  const traitType = createTraitType(env);
  const fields: TraitField[] = [];
  traitType.fields = fields;

  // Set the definedInModulePath for orphan rule checks
  if (context.currentModulePath) {
    traitType.definedInModulePath = context.currentModulePath;
  }

  // Push a scoped env frame for trait evaluation (where-clause constraints and associated types)
  env = pushEnvFrame(env);

  const args = expr.args;

  // Create "Self" type, which is a SomeType containing the current traitType
  const selfType = createSomeType(createType0(), "Self", { env, context });
  selfType.trait = traitType;

  // Attach Runtime trait to the traitType (which is now Self's trait)
  // This must be done AFTER setting selfType.trait = traitType
  // because createSomeType attaches Runtime to selfType's initial trait,
  // which then gets replaced by traitType
  const runtimeTraitType = getTraitTypeFromEnv(env, "Runtime");
  if (runtimeTraitType) {
    env = attachTraitToReceiverType("Runtime", selfType, env, context);
  }

  let whereClauseExprs: Expr[] | undefined = undefined;
  if (args.length > 0) {
    const lastArg = args[args.length - 1]!;
    if (
      exprIsFunctionCall(lastArg) &&
      exprIsFunctionCallOf(lastArg, BuiltinKeywords.where)
    ) {
      whereClauseExprs = lastArg.args;
      if (whereClauseExprs.length === 0) {
        throw formatErrorMessage({
          token: lastArg.token,
          errorMessage: `The where clause must have at least one constraint.`,
        });
      }
    }
  }

  // Pre-parse where-clause constraints (if any) so Self constraints are available
  // when evaluating trait fields.
  let pendingConstraints: PendingTraitConstraint[] = [];
  const traitContext = { ...context, SelfTraitType: traitType };
  if (whereClauseExprs && whereClauseExprs.length > 0) {
    const prepResult = parseTraitWhereClauseConstraints({
      constraintExprs: whereClauseExprs,
      env,
      context: traitContext,
      selfType,
      traitType,
      collectPendingTraits: true,
    });
    env = prepResult.env;
    pendingConstraints = prepResult.pendingTraits;
  }

  // Evaluate trait fields (skip where clause if present at the end)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (
      exprIsFunctionCall(arg) &&
      exprIsFunctionCallOf(arg, BuiltinKeywords.where)
    ) {
      if (i !== args.length - 1) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `The where clause must be the last argument in a trait definition.`,
        });
      }
      continue;
    }

    // trait field
    {
      const { field: field, env: nextEnv } = evaluateTraitField({
        expr: arg,
        env,
        traitFieldIndex: i,
        context: {
          ...traitContext,
          SelfType: selfType, // Self refers to the implementing type
          SelfTraitType: traitType, // SelfTrait refers to the trait being defined
        },
        isForEvaluatingTraitType: true,
      });

      // Check if there is duplicate labels
      const duplicateLabel = fields.find((elem) => elem.label === field.label);
      if (duplicateLabel) {
        throw formatErrorMessage({
          token: exprIsFunctionCall(arg)
            ? (arg.args[0]?.token ?? arg.token)
            : arg.token,
          errorMessage: `Duplicate label 3 "${field.label}" in trait`,
        });
      }

      fields.push(field);
      env = nextEnv;

      // If this is an associated type, bind it in the scoped env
      if (field.unassignedSomeType) {
        const existingVars = getVariablesFromEnv(env, field.label);
        const existingVar = existingVars[existingVars.length - 1];
        const existingSomeType =
          existingVar?.value &&
          isTypeValue(existingVar.value[0]) &&
          isSomeType(existingVar.value[0].value)
            ? (existingVar.value[0].value as SomeType)
            : undefined;
        if (existingSomeType?.id !== field.unassignedSomeType.id) {
          const typeValue = createTypeValue(field.unassignedSomeType);
          const token =
            field.exprs.labelExpr?.token ?? field.exprs.expr.token ?? arg.token;
          const { env: envWithAssociatedType } = addVariableToEnv({
            env,
            variable: {
              name: field.label,
              type: typeValue.type,
              isCompileTimeOnly: true,
              value: [typeValue],
              token,
              initializedAtToken: token,
              consumedAtToken: undefined,
              isOwningTheRcValue: false,
              isOwningTheSameRcValueAs: undefined,
              isReassignable: false,
            },
            allowVariableShadowing: true,
          });
          env = envWithAssociatedType;
        }
      }

      // Don't add field to env - trait fields are accessed via Self.XXX
    }
  }

  // Retry any pending where constraints after all fields are evaluated
  if (pendingConstraints.length > 0) {
    const stillPending: PendingTraitConstraint[] = [];
    for (const pending of pendingConstraints) {
      const result = applySingleTraitConstraintForTrait({
        lhsExpr: pending.lhsExpr,
        traitExpr: pending.traitExpr,
        originalConstraintExpr: pending.originalConstraintExpr,
        env,
        context: traitContext,
        selfType,
        traitType,
      });
      env = result.env;
      if (!result.success) {
        stillPending.push(pending);
      }
    }

    if (stillPending.length > 0) {
      const failedConstraint = stillPending[0]!;
      // Re-evaluate to get the actual error message
      parseTraitWhereClauseConstraints({
        constraintExprs: [failedConstraint.originalConstraintExpr],
        env,
        context: traitContext,
        selfType,
        traitType,
        collectPendingTraits: false,
      });
    }
  }

  // Validate comptime function types in trait fields.
  // This must run AFTER pending where-clause constraints are applied, because
  // constraints like `Self.Output <: Comptime` are pending until the associated
  // type `Output` is created during field evaluation.
  for (const field of fields) {
    if (!isFunctionType(field.type)) continue;
    const fnType = field.type;

    // Check comptime return type
    if (
      fnType.return.isCompileTimeOnly &&
      typeContainsSomeType(fnType.return.type)
    ) {
      const missingSomeType = findSomeTypeMissingComptimeConstraint(
        fnType.return.type,
        env
      );
      if (missingSomeType) {
        const token = fnType.return.typeExpr?.token ?? expr.token;
        throw formatErrorMessage({
          token,
          errorMessage: `Return type "${typeToString(
            fnType.return.type
          )}" in trait field "${field.label}" is used with "comptime" but type parameter "${typeToString(
            missingSomeType
          )}" does not implement the Comptime trait. Add "${missingSomeType.name} <: Comptime" to the where clause.`,
        });
      }
    }

    // Check comptime parameters
    for (const param of fnType.parameters) {
      if (param.isCompileTimeOnly && typeContainsSomeType(param.type)) {
        const missingSomeType = findSomeTypeMissingComptimeConstraint(
          param.type,
          env
        );
        if (missingSomeType) {
          const token = param.exprs.typeExpr?.token ?? expr.token;
          throw formatErrorMessage({
            token,
            errorMessage: `Parameter type "${typeToString(
              param.type
            )}" in trait field "${field.label}" is used with "comptime" but type parameter "${typeToString(
              missingSomeType
            )}" does not implement the Comptime trait. Add "${missingSomeType.name} <: Comptime" to the where clause.`,
          });
        }
      }
    }
  }

  // Pop the scoped env frame before returning
  env = popEnvFrame(env, true);

  const traitTypeValue = createTypeValue(traitType);
  expr.$ = {
    env,
    value: traitTypeValue,
    type: traitTypeValue.type,
    pathCollection: [],
  };

  // Append more information to "module" token.
  expr.func.$ = expr.$;
  return expr;
}
