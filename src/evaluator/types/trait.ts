import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  createSomeType,
  createTraitType,
  createType0,
  isFunctionType,
  isTraitType,
  isTypeHierarchyType,
  SomeType,
  TraitField,
  Type,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { randomId } from "../../utils";
import {
  createTypeValue,
  createUnknownValue,
  isTypeValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isValidVariableName } from "../utils";

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
    const expectedType = fieldType
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
        expectedType: expectedType,
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

    // Check if assignedValueType matches expectedType
    if (expectedType) {
      if (
        !areTypesCompatible(
          { type: expectedType.type, env },
          { type: assignedValueType, env }
        )
      ) {
        throw formatErrorMessage({
          token: assignedValueExpr.token,
          errorMessage: `Assigned value type mismatch:
Expected type: ${typeToString(expectedType.type)}
Given type: ${typeToString(assignedValueType)}`,
        });
      }
      fieldType = expectedType.type;
    } else {
      fieldType = assignedValueType;
    }
  }

  // Evaluate defaultValueExpr if it exists
  if (defaultValueExpr) {
    const expectedType = fieldType
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
        expectedType: expectedType,
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

    // Check if defaultValueType matches expectedType
    if (expectedType) {
      if (
        !areTypesCompatible(
          { type: expectedType.type, env },
          { type: defaultValueType, env }
        )
      ) {
        throw formatErrorMessage({
          token: defaultValueExpr.token,
          errorMessage: `Default value type mismatch:
Expected type: ${typeToString(expectedType.type)}
Given type: ${typeToString(defaultValueType)}`,
        });
      }
      fieldType = expectedType.type;
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
          errorMessage: `Function forall parameter "${param.label}" in trait field "${label ?? "unnamed"}" must have an explicit type annotation.
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
    // Also validate return type has expr
    if (!fieldType.return.expr) {
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
      value: assignedValue ?? createUnknownValue(fieldType, label),
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
    unassignedSomeType = createSomeType(
      fieldType,
      label ?? `$associated_type_${randomId(env.modulePath)}`,
      undefined,
      undefined,
      undefined,
      undefined,
      env
    );
  }

  return {
    field: {
      label: label ?? `$field_${randomId(env.modulePath)}`,
      type: fieldType,
      exprs: {
        expr,
        labelExpr,
        typeExpr,
        defaultValueExpr,
        assignedValueExpr,
      },
      isCompileTimeOnly: true,
      defaultValue,
      assignedValue,
      unassignedSomeType,
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

  // Don't push env frame - trait fields shouldn't be in env

  const args = expr.args;

  // Create "Self" type, which is a SomeType containing the current traitType
  const selfType = createSomeType(createType0(), "Self");
  selfType.trait = traitType;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    // where clause for adding constraints to Self
    if (
      exprIsFunctionCall(arg) &&
      exprIsFunctionCallOf(arg, BuiltinKeywords.where)
    ) {
      // where clause must be the first argument in a trait
      if (i !== 0) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `The where clause must be the first argument in a trait definition.`,
        });
      }

      // Process each constraint in the where clause
      const constraintExprs = arg.args;
      if (constraintExprs.length === 0) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `The where clause must have at least one constraint.`,
        });
      }

      // Initialize selfConstraints array if not already
      if (!traitType.selfConstraints) {
        traitType.selfConstraints = [];
      }

      for (const constraintExpr of constraintExprs) {
        // Each constraint must be of the form: Self <: Trait or Self <: (Trait1, Trait2)
        if (
          !exprIsFunctionCall(constraintExpr) ||
          !exprIsFunctionCallOf(constraintExpr, "<:", 2)
        ) {
          throw formatErrorMessage({
            token: constraintExpr.token,
            errorMessage: `Expected constraint in the form "Self <: Trait" or "Self <: (Trait1, Trait2)", got: ${exprToString(constraintExpr)}`,
          });
        }

        // Check that LHS is "Self"
        const lhsExpr = constraintExpr.args[0]!;
        if (!exprIsAtom(lhsExpr) || lhsExpr.token.value !== "Self") {
          throw formatErrorMessage({
            token: lhsExpr.token,
            errorMessage: `In a trait's where clause, the left-hand side of <: must be "Self", got: ${exprToString(lhsExpr)}`,
          });
        }

        // Extract trait types from RHS before evaluating the constraint
        // Support both single trait and tuple of traits
        // Also handle negated traits: !(Trait)
        const rhsExpr = constraintExpr.args[1]!;
        const traitExprs: { expr: Expr; isNegated: boolean }[] = [];
        if (
          exprIsFunctionCall(rhsExpr) &&
          exprIsFunctionCallOf(rhsExpr, BuiltinKeywords.tuple)
        ) {
          for (const traitExpr of rhsExpr.args) {
            // Check if this is a negated trait: !(Trait)
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
          // Check if this is a negated trait: !(Trait)
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

        // Initialize negativeSelfConstraints array if not already
        if (!traitType.negativeSelfConstraints) {
          traitType.negativeSelfConstraints = [];
        }

        // Evaluate each module expression to get the ModuleType
        for (const { expr: traitExpr, isNegated } of traitExprs) {
          const evaluatedTrait = evaluateExpression({
            expr: traitExpr,
            env,
            context: {
              ...context,
              SelfType: selfType,
            },
          });
          if (evaluatedTrait.$?.env) {
            env = evaluatedTrait.$.env;
          }
          if (
            evaluatedTrait.$?.value &&
            isTypeValue(evaluatedTrait.$.value) &&
            isTraitType(evaluatedTrait.$.value.value)
          ) {
            const constraintTraitType = evaluatedTrait.$.value.value;
            if (isNegated) {
              traitType.negativeSelfConstraints.push(constraintTraitType);
            } else {
              traitType.selfConstraints.push(constraintTraitType);
            }
          }
        }

        // Evaluate with isInsideWhereClause context
        // The SelfType is already set to selfType which is a SomeType
        const evaluated = evaluateExpression({
          expr: constraintExpr,
          env,
          context: {
            ...context,
            SelfType: selfType,
            isInsideWhereClause: true,
          },
        });
        if (evaluated.$?.env) {
          env = evaluated.$.env;
        }
      }
    }
    // trait field
    else {
      const { field: field, env: nextEnv } = evaluateTraitField({
        expr: arg,
        env,
        traitFieldIndex: i,
        context: {
          ...context,
          SelfType: selfType, // Self refers to the trait itself
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

      // Expect field to be compile-time only
      if (!field.isCompileTimeOnly) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected compile-time only field for extern trait, got ${exprToString(arg)}`,
        });
      }

      // Don't add field to env - module fields are accessed via Self.XXX
    }
  }

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
