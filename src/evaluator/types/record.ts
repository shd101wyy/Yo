import type { Environment } from "../../env";
import { getDocCommentLookupKey } from "../../doc/extractor";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import type { TypeField, Type } from "../../types/definitions";
import { isFunctionType, isSourceNamespaceType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import { VUnit } from "../../unit-value";
import { randomId } from "../../utils";
import { createUnknownValue, isTypeValue, type Value } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isValidVariableName } from "../utils";

/**
 * Evaluate a field in a record type expression.
 *
 * type:
 * (x: i32) in struct(x: i32, ...)
 *
 * Fields are compile-time only by default while defining a type.
 */
export function evaluateRecordField({
  expr,
  recordFieldIndex,
  env,
  context,
  isForEvaluatingRecordType,
}: {
  expr: Expr;
  recordFieldIndex: number;
  env: Environment;
  context: EvaluatorContext;
  isForEvaluatingRecordType: boolean;
}): { field: TypeField; env: Environment } {
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
        errorMessage: `Cannot use "::" for record type field. Use ":=" instead.
Record type fields are compile-time only by default.`,
      });
    }

    assignedValueExpr = expr_.args[1]!;
    expr_ = expr_.args[0]!;
  }

  // Cannot have both defaultValueExpr and assignedValueExpr
  if (defaultValueExpr && assignedValueExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Cannot have both default value and required value for record type field.`,
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
        errorMessage: `No need to use "comptime" modifier. Record type fields are compile-time only by default.`,
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
      errorMessage: `No need to use "comptime" modifier. Record type fields are compile-time only by default.`,
    });
  } else if (!defaultValueExpr && !assignedValueExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected label for record type field, got ${exprToString(expr_)}`,
    });
  } else {
    //  eg:
    //    Output ?= Self
    labelExpr = expr_;

    if (!isValidVariableName(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for record type field label, got ${exprToString(labelExpr)}`,
      });
    }
    if (!exprIsAtom(labelExpr) && !isValidVariableName(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for record type field label, got ${exprToString(labelExpr)}`,
      });
    }
    label = labelExpr.token.value;
  }

  // Check expectedType
  const expectedType = context.expectedType?.type;
  let expectedRecordFieldType: Type | undefined = undefined;
  if (expectedType) {
    if (isSourceNamespaceType(expectedType)) {
      const recordField = expectedType.fields[recordFieldIndex];
      if (!recordField) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to get the field at index ${recordFieldIndex}`,
        });
      }

      expectedRecordFieldType = recordField.type;
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
        expectedType: expectedRecordFieldType
          ? {
              type: expectedRecordFieldType,
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
        errorMessage: `Expected type for record type field, got ${exprToString(typeExpr)}`,
      });
    }
    fieldType = typeValue.value;
  }

  // Evaluate assignedValueExpr if it exists
  if (assignedValueExpr) {
    const fieldExpectedType = fieldType
      ? { type: fieldType, env }
      : expectedRecordFieldType
        ? {
            type: expectedRecordFieldType,
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
      : expectedRecordFieldType
        ? {
            type: expectedRecordFieldType,
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
  if (isForEvaluatingRecordType && isFunctionType(fieldType)) {
    // Note: variadic function parameters are allowed in record type fields for
    // builtin-intercepted functions. The type specialization
    // constraint doesn't apply because these calls are intercepted before
    // reaching the normal function call path.
    for (const param of fieldType.forallParameters) {
      if (!param.exprs.typeExpr) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Function generic parameter "${param.label}" in record type field "${label ?? "unnamed"}" must have an explicit type annotation.
Type expressions are required for all function parameters in record type fields to support proper type specialization.`,
        });
      }
    }
    for (const param of fieldType.parameters) {
      if (!param.exprs.typeExpr) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Function parameter "${param.label}" in record type field "${label ?? "unnamed"}" must have an explicit type annotation.
Type expressions are required for all function parameters in record type fields to support proper type specialization.`,
        });
      }
    }
    // Also validate return type has typeExpr
    if (!fieldType.return.typeExpr) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Function in record type field "${label ?? "unnamed"}" must have an explicit return type annotation.
Type expressions are required for return types in record type fields to support proper type specialization.`,
      });
    }
  }

  // Validate default value expression restrictions
  if (isForEvaluatingRecordType && defaultValueExpr) {
    if (!isFunctionType(fieldType)) {
      throw formatErrorMessage({
        token: defaultValueExpr.token,
        errorMessage: `Default values (?=) are only allowed for function-typed record fields (excluding closures).
Record field "${label ?? "unnamed"}" has type: ${typeToString(fieldType)}

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
      docComment: labelExpr
        ? context.docCommentLookup?.get(getDocCommentLookupKey(labelExpr.token))
        : undefined,
    },
    env,
  };
}
