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
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  createModuleType,
  isClosureType,
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
  createUnknownValue,
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
}: {
  expr: Expr;
  moduleElementIndex: number;
  env: Environment;
  context: EvaluatorContext;
}): { type: ModuleElement; env: Environment } {
  let label: string | undefined = undefined;
  let expr_ = expr;

  let labelExpr: Expr | undefined = undefined;
  let typeExpr: Expr | undefined = undefined;

  let defaultValueExpr: Expr | undefined = undefined;
  // Note: defaultValue is not pre-computed anymore - removed to avoid circular dependencies

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
  // Note: We only validate type compatibility here during module type definition.
  // The actual default value will be re-evaluated during module instantiation
  // to handle dependencies on other module elements (e.g., Output ?= Self).
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
  if (defaultValueExpr) {
    if (!isFunctionType(elementType) || isClosureType(elementType)) {
      throw formatErrorMessage({
        token: defaultValueExpr.token,
        errorMessage: `Default values (?=) are only allowed for function type module elements (excluding closures).
Module element "${label ?? "unnamed"}" has type: ${typeToString(elementType)}

To avoid circular dependency issues, please explicitly provide the value for this element.`,
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
      // Note: defaultValue is not pre-computed anymore - it will be re-evaluated
      // during module instantiation from defaultValueExpr
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

  // Push env frame
  env = pushEnvFrame(env);

  const args = expr.args;
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
          SelfType: undefined, // No SelfType in module context
          ModuleType: moduleType,
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

            // Add the element to the environment
            const { env: nextEnv } = addVariableToEnv({
              env,
              variable: {
                name: extendedModuleElement.label,
                type: extendedModuleElement.type,
                value:
                  extendedModuleElement.assignedValue ??
                  createUnknownValue(
                    extendedModuleElement.type,
                    extendedModuleElement.label
                  ),
                isCompileTimeOnly: extendedModuleElement.isCompileTimeOnly,
                token: extendedModuleElement.exprs.expr.token,
                initializedAtToken: extendedModuleElement.exprs.expr.token,
                consumedAtToken: undefined,
              },
            });
            env = nextEnv;
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

            // Add the element to the environment
            const { env: nextEnv } = addVariableToEnv({
              env,
              variable: {
                name: extendedModuleElement.label,
                type: extendedModuleElement.type,
                value: elementValue,
                isCompileTimeOnly: extendedModuleElement.isCompileTimeOnly,
                token: extendedModuleElement.exprs.expr.token,
                initializedAtToken: extendedModuleElement.exprs.expr.token,
                consumedAtToken: undefined,
              },
            });
            env = nextEnv;
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
          SelfType: undefined, // No SelfType in module context
          ModuleType: moduleType,
        },
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

      // Add element to env
      const { env: nextNextEnv } = addVariableToEnv({
        env,
        variable: {
          name: element.label,
          type: element.type,
          value:
            element.assignedValue ??
            createUnknownValue(element.type, element.label),
          isCompileTimeOnly: element.isCompileTimeOnly,
          token: element.exprs.expr.token,
          initializedAtToken: element.exprs.expr.token,
          consumedAtToken: undefined,
        },
      });
      env = nextNextEnv;
    }
  }

  // Pop env frame
  env = popEnvFrame(env);

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
