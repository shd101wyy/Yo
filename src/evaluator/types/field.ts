import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "../../expr";
import {
  areTypesCompatible,
  isModuleType,
  isStructType,
  isTraitType,
  isTupleType,
  prohibitVoidType,
  Type,
  TypeField,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import {
  isFunctionValue,
  isModuleValue,
  isTraitValue,
  isTypeValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isValidVariableName } from "../utils";

/**
 * Evaluate the element in rvalue
 *
 * type:
 * i32 in (i32, ...)
 * (x: i32) in (x: i32, ...)
 */
export function evaluateTypeField({
  expr,
  tupleFieldIndex,
  env,
  context,
  forType,
}: {
  expr: Expr;
  tupleFieldIndex: number;
  env: Environment;
  context: EvaluatorContext;
  forType: "tuple" | "struct" | "enum" | "union";
}): { field: TypeField; env: Environment } {
  let label: string | undefined = undefined;
  let expr_ = expr;

  let labelExpr: Expr | undefined = undefined;
  let typeExpr: Expr | undefined = undefined;

  let defaultValueExpr: Expr | undefined = undefined;
  let defaultValue: Value | undefined = undefined;

  let assignedValueExpr: Expr | undefined = undefined;
  let assignedValue: Value | undefined = undefined;

  let isCompileTimeOnly = false;

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
      exprIsFunctionCallOf(expr_, "::", 2))
  ) {
    if (exprIsFunctionCallOf(expr_, "::", 2)) {
      isCompileTimeOnly = true;

      labelExpr = expr_.args[0]!;

      if (!isValidVariableName(labelExpr)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Expected identifier for element label, got ${exprToString(labelExpr)}`,
        });
      }
      label = labelExpr.token.value;
    }

    assignedValueExpr = expr_.args[1]!;
    expr_ = expr_.args[0]!;
  }

  // Cannot have both defaultValueExpr and assignedValueExpr
  if (defaultValueExpr && assignedValueExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Cannot have both default value and required value for element.`,
    });
  }

  // Parse the lhs expr
  if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":", 2)) {
    labelExpr = expr_.args[0]!;
    typeExpr = expr_.args[1]!;

    // Check if it's compile-time only
    if (
      exprIsFunctionCall(labelExpr) &&
      exprIsFunctionCallOf(labelExpr, BuiltinKeywords.compt, 1)
    ) {
      if (isCompileTimeOnly) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Cannot combine the use of "compt"  with ::`,
        });
      }
      isCompileTimeOnly = true;
      labelExpr = labelExpr.args[0]!;
    }

    if (!exprIsAtom(labelExpr) || !isValidVariableName(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for element label, got ${exprToString(labelExpr)}`,
      });
    }
    label = labelExpr.token.value;
  } else if (
    exprIsFunctionCall(expr_) &&
    exprIsFunctionCallOf(expr_, BuiltinKeywords.compt, 1)
  ) {
    if (isCompileTimeOnly) {
      throw formatErrorMessage({
        token: expr_.token,
        errorMessage: `Cannot combine the use of "compt"  with "::"`,
      });
    }

    isCompileTimeOnly = true;
    labelExpr = expr_.args[0]!;

    // Check if labelExpr is an atom
    if (!exprIsAtom(labelExpr) || !isValidVariableName(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for element label, got ${exprToString(labelExpr)}`,
      });
    }
    label = labelExpr.token.value;
  } else if (!defaultValueExpr && !assignedValueExpr) {
    // Prevent the case such as:
    //   Self :: i32
    // typeExpr shouldn't be "Self"
    typeExpr = expr_;
  }

  // Check expectedType
  const expectedType = context.expectedType?.type;
  let expectedTupleElementType: Type | undefined = undefined;
  if (expectedType) {
    if (
      isTupleType(expectedType) ||
      isStructType(expectedType) ||
      isModuleType(expectedType) ||
      isTraitType(expectedType)
    ) {
      const tupleElement = expectedType.fields[tupleFieldIndex];
      if (!tupleElement) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to get the field at index ${tupleFieldIndex}`,
        });
      }

      expectedTupleElementType = tupleElement.type;
    } else {
      /*
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `(1) Failed to evaluate the tuple fields. Expected type to be:
${typeToString(expectedType)}`
        });
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
        expectedType: expectedTupleElementType
          ? {
              type: expectedTupleElementType,
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
        errorMessage: `(1) Expected type for element, got ${exprToString(typeExpr)}`,
      });
    }
    fieldType = typeValue.value;
  }

  // Evaluate assignedValueExpr if it exists
  if (assignedValueExpr) {
    // Assigned value only works for compile-time only
    if (!isCompileTimeOnly) {
      throw formatErrorMessage({
        token: assignedValueExpr.token,
        errorMessage: `Assigned value expression is only allowed for compile-time only.
Please consider adding "compt"  modifier to the field label.`,
      });
    }

    const expectedType = fieldType
      ? { type: fieldType, env }
      : expectedTupleElementType
        ? {
            type: expectedTupleElementType,
            env,
          }
        : undefined;

    const evaluatedAssignedValueExpr = evaluateExpression({
      expr: assignedValueExpr,
      env,
      context: {
        ...context,
        expectedType: expectedType,
        // Don't propagate forceCompileTimeBindings when evaluating type field values.
        // The field value itself is compile-time (it's a constant method/value),
        // but its internal parameters/body should not be forced to compile-time.
        // For example, `is_some :: (fn(self: Self) -> bool)(...)` - the `self` parameter
        // should be a runtime parameter, not compile-time.
        forceCompileTimeBindings: undefined,
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
      : expectedTupleElementType
        ? {
            type: expectedTupleElementType,
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
      errorMessage: `Failed to infer the element type`,
    });
  }

  // New availability-based validation:
  // - If isCompileTimeOnly = true: the type MUST be available at compile-time
  // - If isCompileTimeOnly = false: no validation - the field contributes to struct availability
  const fieldAvailability = fieldType.availability;

  if (isCompileTimeOnly && !fieldAvailability.comptime) {
    // Field is marked as compile-time-only but type is runtime-only
    throw formatErrorMessage({
      token: labelExpr?.token ?? expr.token,
      errorMessage: `Type '${typeToString(fieldType)}' can only be used at runtime and cannot have "compt" modifier or :: syntax.`,
    });
  }

  if (forType !== "tuple" && !labelExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected label for ${forType} field, got ${exprToString(expr_)}`,
    });
  }

  if (labelExpr) {
    labelExpr.$ = {
      env,
      type: fieldType,
      value: assignedValue ?? defaultValue ?? undefined,
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

  // Prohibit void type
  prohibitVoidType(fieldType, expr.token);

  const field: TypeField = {
    label: label ?? `${tupleFieldIndex}`,
    type: fieldType,
    exprs: {
      expr,
      labelExpr,
      typeExpr,
      defaultValueExpr,
      assignedValueExpr,
    },
    isCompileTimeOnly,
    defaultValue,
    assignedValue,
  };

  if (field.isCompileTimeOnly) {
    // Compile-time field must have an assigned value
    if (!field.assignedValue) {
      // NOTE: Let's allow to have compile-time only field without assigned value for now
      // throw formatErrorMessage({
      //   token: field.exprs.expr.token,
      //   errorMessage: `Compile-time only field "${field.label}" must have an assigned value.`,
      // });
    } else {
      // Attach .typeName info if necessary
      // But don't modify SelfType - it's a reference to the enclosing type
      if (
        isTypeValue(field.assignedValue) &&
        !field.assignedValue.value.typeName &&
        field.assignedValue.value !== context.SelfType
      ) {
        field.assignedValue.value.typeName = field.label;
      } else if (
        isFunctionValue(field.assignedValue) &&
        !field.assignedValue.funcName
      ) {
        field.assignedValue.funcName = field.label;
        field.assignedValue.funcId += `_${field.label}`;
      } else if (
        (isModuleValue(field.assignedValue) ||
          isTraitValue(field.assignedValue)) &&
        !field.assignedValue.type.typeName &&
        field.assignedValue.type !== context.SelfType
      ) {
        field.assignedValue.type.typeName = field.label;
      }
    }
  }

  return {
    field: field,
    env,
  };
}
