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
  isModuleType,
  TupleElement,
  Type,
  typeToString,
} from "../../type-checker";
import { VUnit } from "../../unit-value";
import { randomId } from "../../utils";
import {
  createTypeValue,
  createUnknownValue,
  isTypeValue,
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
  tupleElementIndex,
  env,
  context,
}: {
  expr: Expr;
  tupleElementIndex: number;
  env: Environment;
  context: EvaluatorContext;
}): { type: TupleElement; env: Environment } {
  let label: string | undefined = undefined;
  let expr_ = expr;

  let labelExpr: Expr | undefined = undefined;
  let typeExpr: Expr | undefined = undefined;

  let defaultValueExpr: Expr | undefined = undefined;
  let defaultValue: Value | undefined = undefined;

  let assignedValueExpr: Expr | undefined = undefined;
  let assignedValue: Value | undefined = undefined;

  let isImplicit = false;

  let elementType: Type | undefined = undefined;

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

  // Parse the lhs expr
  if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":", 2)) {
    labelExpr = expr_.args[0]!;
    typeExpr = expr_.args[1]!;

    // Check if it's compile-time only
    if (
      exprIsFunctionCall(labelExpr) &&
      exprIsFunctionCallOf(labelExpr, BuiltinKeywords.compt, 1)
    ) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `No need to use "compt" (or "@") modifier. All module elements are compile-time only by default.`,
      });
    }

    // Check isImplicit
    if (
      exprIsFunctionCall(labelExpr) &&
      exprIsFunctionCallOf(labelExpr, BuiltinKeywords.implicit, 1)
    ) {
      isImplicit = true;
      labelExpr = labelExpr.args[0]!;
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
    exprIsFunctionCall(expr_) &&
    exprIsFunctionCallOf(expr_, BuiltinKeywords.compt, 1)
  ) {
    throw formatErrorMessage({
      token: expr_.token,
      errorMessage: `No need to use "compt" (or "@") modifier. All module elements are compile-time only by default.`,
    });
  } else if (!defaultValueExpr && !assignedValueExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected label for module field, got ${exprToString(expr_)}`,
    });
  } else {
    //  eg:
    //    Output ?= Self
    labelExpr = expr_;

    // Check isImplicit
    if (
      exprIsFunctionCall(labelExpr) &&
      exprIsFunctionCallOf(labelExpr, BuiltinKeywords.implicit, 1)
    ) {
      isImplicit = true;
      labelExpr = labelExpr.args[0]!;
    }

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
      const tupleElement = expectedType.elements[tupleElementIndex];
      if (!tupleElement) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to get the field at index ${tupleElementIndex}`,
        });
      }

      expectedTupleElementType = tupleElement.type;
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

  /*
    if (typeRequiresComptModifier(elementType) && !isCompileTimeOnly) {
      elementType = convertComptTypeToRuntimeType(elementType);
      if (typeRequiresComptModifier(elementType)) {
        throw formatErrorMessage(
          labelExpr?.token ?? expr.token,
          `Expected "compt" (or "@") modifier for compile-time known value binding.`
        );
      }
    }
    */

  if (labelExpr) {
    labelExpr.$ = {
      env,
      type: elementType,
      isMutable: false,
      pathCollection: [],
    };
  }

  if (expr !== typeExpr) {
    expr.$ = {
      env,
      value: VUnit,
      type: VUnit.type,
      isMutable: false,
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
  const moduleType = createModuleType([], env);
  const elements: TupleElement[] = [];
  moduleType.elements = elements;

  // Push env frame
  env = pushEnvFrame(env);

  const args = expr.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    // NOTE: Type methods are not allowed in module types.
    // spread operator for extending another module
    if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "...", 1)) {
      const extendedStructExpr = arg.args[0]!;
      // Evaluate the extended struct expression
      const evaluatedExtendedModuleExpr = context.evaluateExpression({
        expr: extendedStructExpr,
        env,
        context: {
          ...context,
          SelfType: undefined, // No SelfType in module context
          ModuleType: moduleType,
        },
      });
      if (!evaluatedExtendedModuleExpr.$) {
        throw formatErrorMessage({
          token: extendedStructExpr.token,
          errorMessage: `Failed to evaluate the extended struct expression: ${exprToString(extendedStructExpr)}`,
        });
      }

      // Check if it's a module type
      const extendedModuleTypeValue = evaluatedExtendedModuleExpr.$.value;
      if (
        !isTypeValue(extendedModuleTypeValue) ||
        !isModuleType(extendedModuleTypeValue.value)
      ) {
        throw formatErrorMessage({
          token: extendedStructExpr.token,
          errorMessage: `Expected a struct type for extending, got ${exprToString(
            extendedStructExpr
          )}`,
        });
      }
      const extendedModuleType = extendedModuleTypeValue.value;

      // Iterate over the elements of the extended struct
      for (const extendedModuleElement of extendedModuleType.elements) {
        // Check if there is duplicate labels
        // If yes, then override the element
        const duplicateLabelIndex = elements.findIndex(
          (e) => e.label === extendedModuleElement.label
        );
        if (duplicateLabelIndex >= 0) {
          throw formatErrorMessage({
            token: extendedStructExpr.token,
            errorMessage: `Duplicate label "${extendedModuleElement.label}" in module`,
          });
        } else {
          // Add the element to the struct
          elements.push(extendedModuleElement);

          // Add the element to the environment
          const { env: nextEnv } = addVariableToEnv({
            env,
            variable: {
              name: extendedModuleElement.label,
              type: extendedModuleElement.type,
              value: extendedModuleElement.isCompileTimeOnly
                ? (extendedModuleElement.assignedValue ??
                  createUnknownValue(
                    extendedModuleElement.type,
                    extendedModuleElement.label
                  ))
                : undefined,
              isCompileTimeOnly: extendedModuleElement.isCompileTimeOnly,
              isImplicit: extendedModuleElement.isImplicit,
              isMutable: false,
              isUndefined: false,
              token: extendedModuleElement.exprs.expr.token,
            },
          });
          env = nextEnv;
        }
      }
    }
    // tuple element
    else {
      const { type: element, env: nextEnv } = evaluateModuleElementType({
        expr: arg,
        env,
        tupleElementIndex: i,
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
          errorMessage: `Duplicate label "${element.label}" in module`,
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
          isImplicit: element.isImplicit,
          isMutable: false,
          isUndefined: false,
          token: element.exprs.expr.token,
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
    isMutable: false,
    pathCollection: [],
  };

  // Append more information to "module" token.
  expr.func.$ = expr.$;
  return expr;
}
