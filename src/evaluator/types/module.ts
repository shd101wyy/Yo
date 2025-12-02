import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  createModuleType,
  createSomeType,
  createType0,
  isFunctionType,
  isModuleType,
  ModuleField,
  ModuleType,
  Type,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { randomId } from "../../utils";
import {
  areValuesEqual,
  createTypeValue,
  createUnknownValue,
  isModuleValue,
  isTypeValue,
  isUnknownValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isValidVariableName } from "../utils";

/**
 * Evaluate the field in module rvalue
 *
 * type:
 * (x: i32) in module(x: i32, ...)
 *
 * All fields in module are compile-time only by default.
 */
export function evaluateModuleField({
  expr,
  moduleFieldIndex,
  env,
  context,
  isForEvaluatingModuleType,
}: {
  expr: Expr;
  moduleFieldIndex: number;
  env: Environment;
  context: EvaluatorContext;
  isForEvaluatingModuleType: boolean;
}): { field: ModuleField; env: Environment } {
  let label: string | undefined = undefined;
  let expr_ = expr;

  let labelExpr: Expr | undefined = undefined;
  let typeExpr: Expr | undefined = undefined;

  let defaultValueExpr: Expr | undefined = undefined;
  let defaultValue: Value | undefined = undefined;

  let assignedValueExpr: Expr | undefined = undefined;
  let assignedValue: Value | undefined = undefined;

  let fieldType: Type | undefined = undefined;

  // Check if it's an implicit constraint with new syntax: using(name) : Type
  let isImplicit = false;
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, ":", 2) &&
    exprIsFunctionCall(expr.args[0]!) &&
    exprIsFunctionCallOf(expr.args[0]!, BuiltinKeywords.using, 1)
  ) {
    // New syntax: using(name) : Type
    isImplicit = true;
    const usingCall = expr.args[0]! as FuncCallExpr;
    const nameExpr = usingCall.args[0]!;
    typeExpr = expr.args[1]!;

    if (!exprIsAtom(nameExpr) || !isValidVariableName(nameExpr)) {
      throw formatErrorMessage({
        token: nameExpr.token,
        errorMessage: `Expected identifier for implicit constraint name, got ${exprToString(
          nameExpr
        )}`,
      });
    }

    label = nameExpr.token.value;
    labelExpr = nameExpr;
    expr_ = expr; // Keep the full expression for later processing
  }

  // Check the default value
  if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, "?=", 2)) {
    if (isImplicit) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Implicit constraints (using syntax) cannot have default values`,
      });
    }
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
    if (isImplicit) {
      throw formatErrorMessage({
        token: expr_.token,
        errorMessage: `Implicit constraints (using syntax) cannot have assigned values`,
      });
    }
    if (exprIsFunctionCallOf(expr_, "::", 2)) {
      throw formatErrorMessage({
        token: expr_.token,
        errorMessage: `Cannot use "::" for module field. Use ":=" instead.
All module fields are compile-time only by default.`,
      });
    }

    assignedValueExpr = expr_.args[1]!;
    expr_ = expr_.args[0]!;
  }

  // Cannot have both defaultValueExpr and assignedValueExpr
  if (defaultValueExpr && assignedValueExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Cannot have both default value and required value for module field.`,
    });
  }

  // Parse the lhs expr (skip if we already got label from using(name) syntax)
  if (
    !isImplicit &&
    exprIsFunctionCall(expr_) &&
    exprIsFunctionCallOf(expr_, ":", 2)
  ) {
    labelExpr = expr_.args[0]!;
    typeExpr = expr_.args[1]!;

    // Check if it's compile-time only
    if (
      exprIsFunctionCall(labelExpr) &&
      exprIsFunctionCallOf(labelExpr, BuiltinKeywords.compt, 1)
    ) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `No need to use "compt"  modifier. All module fields are compile-time only by default.`,
      });
    }

    if (!exprIsAtom(labelExpr) && !isValidVariableName(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for tuple field label, got ${exprToString(
          labelExpr
        )}`,
      });
    }
    label = labelExpr.token.value;
  } else if (
    !isImplicit &&
    exprIsFunctionCall(expr_) &&
    exprIsFunctionCallOf(expr_, BuiltinKeywords.compt, 1)
  ) {
    throw formatErrorMessage({
      token: expr_.token,
      errorMessage: `No need to use "compt"  modifier. All module fields are compile-time only by default.`,
    });
  } else if (!isImplicit && !defaultValueExpr && !assignedValueExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected label for module field, got ${exprToString(expr_)}`,
    });
  } else if (!isImplicit) {
    //  eg:
    //    Output ?= Self
    labelExpr = expr_;

    if (!isValidVariableName(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for module field label, got ${exprToString(
          labelExpr
        )}`,
      });
    }
    if (!exprIsAtom(labelExpr) && !isValidVariableName(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for module field label, got ${exprToString(
          labelExpr
        )}`,
      });
    }
    label = labelExpr.token.value;
  }

  // Check expectedType
  const expectedType = context.expectedType?.type;
  let expectedModuleFieldType: Type | undefined = undefined;
  if (expectedType) {
    if (isModuleType(expectedType)) {
      const moduleField = expectedType.fields[moduleFieldIndex];
      if (!moduleField) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to get the field at index ${moduleFieldIndex}`,
        });
      }

      expectedModuleFieldType = moduleField.type;
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
        expectedType: expectedModuleFieldType
          ? {
              type: expectedModuleFieldType,
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
        errorMessage: `(1) Expected type for module field, got ${exprToString(typeExpr)}`,
      });
    }
    fieldType = typeValue.value;
  }

  // Evaluate assignedValueExpr if it exists
  if (assignedValueExpr) {
    const expectedType = fieldType
      ? { type: fieldType, env }
      : expectedModuleFieldType
        ? {
            type: expectedModuleFieldType,
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
      : expectedModuleFieldType
        ? {
            type: expectedModuleFieldType,
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

  // Validate default value expression restrictions
  if (isForEvaluatingModuleType && defaultValueExpr) {
    if (!isFunctionType(fieldType)) {
      throw formatErrorMessage({
        token: defaultValueExpr.token,
        errorMessage: `Default values (?=) are only allowed for function type module elemen
ts (excluding closures).
Module field "${label ?? "unnamed"}" has type: ${typeToString(fieldType)}

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

  return {
    field: {
      label: label ?? `$field_${randomId()}`,
      type: fieldType,
      exprs: {
        expr,
        labelExpr,
        typeExpr,
        defaultValueExpr,
        assignedValueExpr,
      },
      isCompileTimeOnly: true,
      isImplicit,
      defaultValue,
      assignedValue,
    },
    env,
  };
}

export function evaluateModuleType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.module)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "module", got:\n${exprToString(expr)}`,
    });
  }

  // Create moduleType with empty fields
  const moduleType = createModuleType(env);
  const fields: ModuleField[] = [];
  moduleType.fields = fields;

  // Don't push env frame - module fields shouldn't be in env

  const args = expr.args;

  // Create "Self" type, which is a SomeType containing the current moduleType
  const selfType = createSomeType(createType0(), "Self");
  selfType.module = moduleType;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    // NOTE: Type methods are not allowed in module types.
    // spread operator for extending another module
    if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "...", 1)) {
      const extendedModuleExpr = arg.args[0]!;
      // Evaluate the extended struct expression
      const evaluatedExtendedModuleExpr = evaluateExpression({
        expr: extendedModuleExpr,
        env,
        context: {
          ...context,
          SelfType: selfType, // Self refers to the module itself
        },
      });
      if (!evaluatedExtendedModuleExpr.$) {
        throw formatErrorMessage({
          token: extendedModuleExpr.token,
          errorMessage: `Failed to evaluate the extended struct expression: ${exprToString(extendedModuleExpr)}`,
        });
      }

      // Check if it's a module type
      const value = evaluatedExtendedModuleExpr.$.value;
      // Extending a module type
      if (
        (isTypeValue(value) && isModuleType(value.value)) ||
        (isUnknownValue(value) && isModuleType(value.type))
      ) {
        let extendedModuleType: ModuleType;
        if (isTypeValue(value) && isModuleType(value.value)) {
          extendedModuleType = value.value;
        } else {
          extendedModuleType = value.type as ModuleType;
        }

        // Iterate over the fields of the extended struct
        for (const extendedModuleField of extendedModuleType.fields) {
          // Check if there is duplicate labels
          // If yes, then override the field
          const duplicateLabelIndex = fields.findIndex(
            (e) => e.label === extendedModuleField.label
          );
          if (duplicateLabelIndex >= 0) {
            // Check if they have the same value.
            if (
              (fields[duplicateLabelIndex]!.assignedValue &&
                extendedModuleField.assignedValue &&
                areValuesEqual(
                  { value: fields[duplicateLabelIndex]!.assignedValue, env },
                  { value: extendedModuleField.assignedValue, env }
                )) ||
              (!fields[duplicateLabelIndex]!.assignedValue &&
                !extendedModuleField.assignedValue &&
                areTypesCompatible(
                  { type: fields[duplicateLabelIndex]!.type, env },
                  { type: extendedModuleField.type, env }
                ))
            ) {
              continue;
            }

            console.log(
              !!fields[duplicateLabelIndex]!.assignedValue,
              !!extendedModuleField.assignedValue
            );
            console.log(
              typeToString(fields[duplicateLabelIndex]!.type),
              "\n",
              typeToString(extendedModuleField.type),
              "\n",
              areTypesCompatible(
                { type: fields[duplicateLabelIndex]!.type, env },
                { type: extendedModuleField.type, env }
              )
            );

            throw formatErrorMessage({
              token: extendedModuleExpr.token,
              errorMessage: `Duplicate label 1 "${extendedModuleField.label}" in module`,
            });
          } else {
            // Add the field to the module
            fields.push(extendedModuleField);
            // Don't add to environment - module fields are accessed via Self.XXX
          }
        }
      }
      // Check if it's a module value
      else if (isModuleValue(value)) {
        const moduleValue = value;

        // Iterate over the fields of the module value
        for (let i = 0; i < moduleValue.fields.length; i++) {
          const fieldValue = moduleValue.fields[i]!;
          const extendedModuleField = moduleValue.type.fields[i]!;

          // Check if there is a duplicate label
          const duplicateLabelIndex = fields.findIndex(
            (e) => e.label === extendedModuleField.label
          );
          if (duplicateLabelIndex >= 0) {
            // Check if they have the same value.
            if (
              (fields[duplicateLabelIndex]!.assignedValue &&
                extendedModuleField.assignedValue &&
                areValuesEqual(
                  { value: fields[duplicateLabelIndex]!.assignedValue, env },
                  { value: extendedModuleField.assignedValue, env }
                )) ||
              (!fields[duplicateLabelIndex]!.assignedValue &&
                !extendedModuleField.assignedValue &&
                areTypesCompatible(
                  { type: fields[duplicateLabelIndex]!.type, env },
                  { type: extendedModuleField.type, env }
                ))
            ) {
              continue;
            }

            throw formatErrorMessage({
              token: extendedModuleExpr.token,
              errorMessage: `Duplicate label 2 "${extendedModuleField.label}" in module`,
            });
          } else {
            // Add the field to the module
            fields.push({
              ...moduleValue.type.fields[i]!,
              assignedValue: fieldValue,
            });
            // Don't add to environment - module fields are accessed via Self.XXX
          }
        }
      } else {
        throw formatErrorMessage({
          token: extendedModuleExpr.token,
          errorMessage: `Expected a Module type or value for extending, got ${exprToString(
            extendedModuleExpr
          )}`,
        });
      }
    }
    // where clause for adding constraints to Self
    else if (
      exprIsFunctionCall(arg) &&
      exprIsFunctionCallOf(arg, BuiltinKeywords.where)
    ) {
      // where clause must be the first argument in a module
      if (i !== 0) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `The where clause must be the first argument in a module definition.`,
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

      for (const constraintExpr of constraintExprs) {
        // Each constraint must be of the form: Self <: Module or Self <: (Module1, Module2)
        if (
          !exprIsFunctionCall(constraintExpr) ||
          !exprIsFunctionCallOf(constraintExpr, "<:", 2)
        ) {
          throw formatErrorMessage({
            token: constraintExpr.token,
            errorMessage: `Expected constraint in the form "Self <: Module" or "Self <: (Module1, Module2)", got: ${exprToString(constraintExpr)}`,
          });
        }

        // Check that LHS is "Self"
        const lhsExpr = constraintExpr.args[0]!;
        if (!exprIsAtom(lhsExpr) || lhsExpr.token.value !== "Self") {
          throw formatErrorMessage({
            token: lhsExpr.token,
            errorMessage: `In a module's where clause, the left-hand side of <: must be "Self", got: ${exprToString(lhsExpr)}`,
          });
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
    // module field
    else {
      const { field: field, env: nextEnv } = evaluateModuleField({
        expr: arg,
        env,
        moduleFieldIndex: i,
        context: {
          ...context,
          SelfType: selfType, // Self refers to the module itself
        },
        isForEvaluatingModuleType: true,
      });

      // Check if there is duplicate labels
      const duplicateLabel = fields.find((elem) => elem.label === field.label);
      if (duplicateLabel) {
        throw formatErrorMessage({
          token: exprIsFunctionCall(arg)
            ? (arg.args[0]?.token ?? arg.token)
            : arg.token,
          errorMessage: `Duplicate label 3 "${field.label}" in module`,
        });
      }

      fields.push(field);
      env = nextEnv;

      // Expect field to be compile-time only
      if (!field.isCompileTimeOnly) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected compile-time only field for extern module, got ${exprToString(arg)}`,
        });
      }

      // Don't add field to env - module fields are accessed via Self.XXX
    }
  }

  const moduleTypeValue = createTypeValue(moduleType);
  expr.$ = {
    env,
    value: moduleTypeValue,
    type: moduleTypeValue.type,
    pathCollection: [],
  };

  // Append more information to "module" token.
  expr.func.$ = expr.$;
  return expr;
}
