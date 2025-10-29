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
import { generateExprFromCode } from "../../parser";
import {
  areTypesCompatible,
  createModuleType,
  createTypeHierarchy,
  isFunctionType,
  isModuleType,
  ModuleElement,
  ModuleType,
  Type,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { randomId } from "../../utils";
import {
  areValuesEqual,
  createTypeValue,
  isModuleValue,
  isTypeValue,
  isUnknownValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { isValidVariableName } from "../utils";

/**
 * Evaluate the element in module rvalue
 *
 * type:
 * (x: i32) in module(x: i32, ...)
 *
 * All fields in module are compile-time only by default.
 */
export function evaluateModuleElementType({
  expr,
  moduleElementIndex,
  env,
  context,
  isForEvaluatingModuleType,
}: {
  expr: Expr;
  moduleElementIndex: number;
  env: Environment;
  context: EvaluatorContext;
  isForEvaluatingModuleType: boolean;
}): { type: ModuleElement; env: Environment } {
  let label: string | undefined = undefined;
  let expr_ = expr;

  let labelExpr: Expr | undefined = undefined;
  let typeExpr: Expr | undefined = undefined;

  let defaultValueExpr: Expr | undefined = undefined;
  let defaultValue: Value | undefined = undefined;

  let assignedValueExpr: Expr | undefined = undefined;
  let assignedValue: Value | undefined = undefined;

  let elementType: Type | undefined = undefined;

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
        errorMessage: `Cannot use "::" for module element. Use ":=" instead.
All module elements are compile-time only by default.`,
      });
    }

    assignedValueExpr = expr_.args[1]!;
    expr_ = expr_.args[0]!;
  }

  // Cannot have both defaultValueExpr and assignedValueExpr
  if (defaultValueExpr && assignedValueExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Cannot have both default value and required value for tuple element.`,
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
        errorMessage: `No need to use "compt"  modifier. All module elements are compile-time only by default.`,
      });
    }

    if (!exprIsAtom(labelExpr) && !isValidVariableName(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for tuple element label, got ${exprToString(
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
      errorMessage: `No need to use "compt"  modifier. All module elements are compile-time only by default.`,
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
        errorMessage: `Expected identifier for tuple element label, got ${exprToString(
          labelExpr
        )}`,
      });
    }
    if (!exprIsAtom(labelExpr) && !isValidVariableName(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for tuple element label, got ${exprToString(
          labelExpr
        )}`,
      });
    }
    label = labelExpr.token.value;
  }

  // Check expectedType
  const expectedType = context.expectedType?.type;
  let expectedTupleElementType: Type | undefined = undefined;
  if (expectedType) {
    if (isModuleType(expectedType)) {
      const moduleElement = expectedType.elements[moduleElementIndex];
      if (!moduleElement) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to get the field at index ${moduleElementIndex}`,
        });
      }

      expectedTupleElementType = moduleElement.type;
    } else {
      /*
        throw formatErrorMessage(
          expr.token,
          `(1) Failed to evaluate the tuple elements. Expected type to be:
${typeToString(expectedType)}`
        );
        */
      // NOTE: Don't throw error here
    }
  }

  // Parse the type expr
  if (typeExpr) {
    const evaluatedTypeExpr = context.evaluateExpression({
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
        errorMessage: `(1) Expected type for tuple element, got ${exprToString(typeExpr)}`,
      });
    }
    elementType = typeValue.value;
  }

  // Evaluate assignedValueExpr if it exists
  if (assignedValueExpr) {
    const expectedType = elementType
      ? { type: elementType, env }
      : expectedTupleElementType
        ? {
            type: expectedTupleElementType,
            env,
          }
        : undefined;
    const evaluatedAssignedValueExpr = context.evaluateExpression({
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
      elementType = expectedType.type;
    } else {
      elementType = assignedValueType;
    }
  }

  // Evaluate defaultValueExpr if it exists
  if (defaultValueExpr) {
    const expectedType = elementType
      ? { type: elementType, env }
      : expectedTupleElementType
        ? {
            type: expectedTupleElementType,
            env,
          }
        : undefined;
    const evaluatedDefaultValueExpr = context.evaluateExpression({
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
      elementType = expectedType.type;
    } else {
      elementType = defaultValueType;
    }
  }

  if (!elementType) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Failed to infer the element type`,
    });
  }

  // Validate default value expression restrictions
  if (isForEvaluatingModuleType && defaultValueExpr) {
    if (!isFunctionType(elementType)) {
      throw formatErrorMessage({
        token: defaultValueExpr.token,
        errorMessage: `Default values (?=) are only allowed for function type module elemen
ts (excluding closures).
Module element "${label ?? "unnamed"}" has type: ${typeToString(elementType)}

To avoid circular dependency issues, please explicitly provide the value for this element.`,
      });
    }
  }

  if (
    isForEvaluatingModuleType &&
    !assignedValueExpr &&
    !isFunctionType(elementType) &&
    !isModuleType(elementType)
  ) {
    // NOTE: We allow "This" to not have a value assigned
    // "This" is a special case for the receiver type parameter.
    if (label !== "This") {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected an assigned value for module element "${label ?? "unnamed"}"`,
      });
    }
  }

  /*
    if (typeRequiresComptModifier(elementType) && !isCompileTimeOnly) {
      elementType = convertComptTypeToRuntimeType({ type: elementType, expectedType: undefined, expr: undefined });
      if (typeRequiresComptModifier(elementType)) {
        throw formatErrorMessage(
          labelExpr?.token ?? expr.token,
          `Expected "compt"  modifier for compile-time known value binding.`
        );
      }
    }
    */

  if (labelExpr) {
    labelExpr.$ = {
      env,
      type: elementType,
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
    type: {
      label: label ?? `$element_${randomId()}`,
      type: elementType,
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

  // Create moduleType with empty elements
  const moduleType = createModuleType(env);
  const elements: ModuleElement[] = [];
  moduleType.elements = elements;

  // Don't push env frame - module elements shouldn't be in env

  const args = expr.args;

  // Check if "This" label exists in any of the module elements
  let hasThisLabel = false;

  for (const arg of args) {
    // Skip spread operators for this check
    if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "...", 1)) {
      continue;
    }

    // Extract label from the element expression
    let labelExpr: Expr | undefined = undefined;

    // Handle default value:  label ?= value or
    //        assigned value: label := value
    if (
      exprIsFunctionCall(arg) &&
      (exprIsFunctionCallOf(arg, "?=", 2) || exprIsFunctionCallOf(arg, ":=", 2))
    ) {
      labelExpr = arg.args[0]!;
    }
    // Handle assigned value: (label : Type) = value
    else if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=", 2)) {
      const lhsExpr = arg.args[0]!;
      if (
        exprIsFunctionCall(lhsExpr) &&
        exprIsFunctionCallOf(lhsExpr, ":", 2)
      ) {
        labelExpr = lhsExpr.args[0]!;
      }
    }
    // Handle type annotation: label : Type
    else if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, ":", 2)) {
      labelExpr = arg.args[0]!;
    }

    // Analyze labelExpr
    if (labelExpr) {
      if (
        exprIsFunctionCall(labelExpr) &&
        exprIsFunctionCallOf(labelExpr, BuiltinKeywords.using)
      ) {
        labelExpr = labelExpr.args[0]!;
      }

      if (exprIsAtom(labelExpr)) {
        if (labelExpr.token.value === "This") {
          hasThisLabel = true;
        } else if (labelExpr.token.value === "Self") {
          throw formatErrorMessage({
            token: labelExpr.token,
            errorMessage: `"Self" cannot be defined in a module type.
In module types, "Self" refers to the module itself, not a configurable type parameter.
Use "This" instead as the receiver type parameter.

Example:
  Add :: (fn(compt(Rhs): Type, compt(Output) ?= Rhs) -> compt(Module))
    module
      This     : Type,
      Output   := Output,
      (+)      : (fn(lhs: Self.This, rhs: Rhs) -> Self.Output)
    ;`,
          });
        }
      }
    }
  }

  // If "This" is not found, automatically insert "This : Type" at the beginning
  if (!hasThisLabel) {
    // Create "This : Type" element
    const thisType = createTypeHierarchy(0);
    const thisElement: ModuleElement = {
      label: "This",
      type: thisType,
      isCompileTimeOnly: true,
      assignedValue: undefined,
      defaultValue: undefined,
      isImplicit: false,
      exprs: {
        expr: expr,
        labelExpr: undefined,
        typeExpr: generateExprFromCode("Type"),
        defaultValueExpr: undefined,
        assignedValueExpr: undefined,
      },
    };

    elements.push(thisElement);
    // Don't add to environment - module elements are accessed via Self.This
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    // NOTE: Type methods are not allowed in module types.
    // spread operator for extending another module
    if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "...", 1)) {
      const extendedModuleExpr = arg.args[0]!;
      // Evaluate the extended struct expression
      const evaluatedExtendedModuleExpr = context.evaluateExpression({
        expr: extendedModuleExpr,
        env,
        context: {
          ...context,
          SelfType: moduleType, // Self refers to the module itself
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

        // Iterate over the elements of the extended struct
        for (const extendedModuleElement of extendedModuleType.elements) {
          // Check if there is duplicate labels
          // If yes, then override the element
          const duplicateLabelIndex = elements.findIndex(
            (e) => e.label === extendedModuleElement.label
          );
          if (duplicateLabelIndex >= 0) {
            // Check if they have the same value.
            if (
              (elements[duplicateLabelIndex]!.assignedValue &&
                extendedModuleElement.assignedValue &&
                areValuesEqual(
                  { value: elements[duplicateLabelIndex]!.assignedValue, env },
                  { value: extendedModuleElement.assignedValue, env }
                )) ||
              (!elements[duplicateLabelIndex]!.assignedValue &&
                !extendedModuleElement.assignedValue &&
                areTypesCompatible(
                  { type: elements[duplicateLabelIndex]!.type, env },
                  { type: extendedModuleElement.type, env }
                ))
            ) {
              continue;
            }

            console.log(
              !!elements[duplicateLabelIndex]!.assignedValue,
              !!extendedModuleElement.assignedValue
            );
            console.log(
              typeToString(elements[duplicateLabelIndex]!.type),
              "\n",
              typeToString(extendedModuleElement.type),
              "\n",
              areTypesCompatible(
                { type: elements[duplicateLabelIndex]!.type, env },
                { type: extendedModuleElement.type, env }
              )
            );

            throw formatErrorMessage({
              token: extendedModuleExpr.token,
              errorMessage: `Duplicate label 1 "${extendedModuleElement.label}" in module`,
            });
          } else {
            // Add the element to the module
            elements.push(extendedModuleElement);
            // Don't add to environment - module elements are accessed via Self.XXX
          }
        }
      }
      // Check if it's a module value
      else if (isModuleValue(value)) {
        const moduleValue = value;

        // Iterate over the elements of the module value
        for (let i = 0; i < moduleValue.elements.length; i++) {
          const elementValue = moduleValue.elements[i]!;
          const extendedModuleElement = moduleValue.type.elements[i]!;

          // Check if there is a duplicate label
          const duplicateLabelIndex = elements.findIndex(
            (e) => e.label === extendedModuleElement.label
          );
          if (duplicateLabelIndex >= 0) {
            // Check if they have the same value.
            if (
              (elements[duplicateLabelIndex]!.assignedValue &&
                extendedModuleElement.assignedValue &&
                areValuesEqual(
                  { value: elements[duplicateLabelIndex]!.assignedValue, env },
                  { value: extendedModuleElement.assignedValue, env }
                )) ||
              (!elements[duplicateLabelIndex]!.assignedValue &&
                !extendedModuleElement.assignedValue &&
                areTypesCompatible(
                  { type: elements[duplicateLabelIndex]!.type, env },
                  { type: extendedModuleElement.type, env }
                ))
            ) {
              continue;
            }

            throw formatErrorMessage({
              token: extendedModuleExpr.token,
              errorMessage: `Duplicate label 2 "${extendedModuleElement.label}" in module`,
            });
          } else {
            // Add the element to the module
            elements.push({
              ...moduleValue.type.elements[i]!,
              assignedValue: elementValue,
            });
            // Don't add to environment - module elements are accessed via Self.XXX
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
    // module element
    else {
      const { type: element, env: nextEnv } = evaluateModuleElementType({
        expr: arg,
        env,
        moduleElementIndex: i,
        context: {
          ...context,
          SelfType: moduleType, // Self refers to the module itself
        },
        isForEvaluatingModuleType: true,
      });

      // Check if there is duplicate labels
      const duplicateLabel = elements.find(
        (elem) => elem.label === element.label
      );
      if (duplicateLabel) {
        throw formatErrorMessage({
          token: exprIsFunctionCall(arg)
            ? (arg.args[0]?.token ?? arg.token)
            : arg.token,
          errorMessage: `Duplicate label 3 "${element.label}" in module`,
        });
      }

      elements.push(element);
      env = nextEnv;

      // Expect element to be compile-time only
      if (!element.isCompileTimeOnly) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected compile-time only element for extern module, got ${exprToString(arg)}`,
        });
      }

      // Don't add element to env - module elements are accessed via Self.XXX
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
