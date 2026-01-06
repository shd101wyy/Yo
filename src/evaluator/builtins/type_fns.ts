import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  canTypeFormRcCycle,
  createBooleanType,
  createComptStringType,
  isModuleType,
  isTypeHierarchyType,
  ModuleType,
  typeContainsRcType,
  typeToString,
} from "../../types";
import {
  createBooleanValue,
  createComptStringValue,
  createUnknownValue,
  isModuleValue,
  isTypeValue,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { findMatchingGenericImpl } from "../values/module";

export function evaluateYoTypeToString({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_type_to_string, 1);

  const arg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });
  if (!arg.$) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        arg,
      )}`,
    });
  }
  if (!isTypeHierarchyType(arg.$.type)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected TypeHierarchy type for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg,
      )}`,
    });
  }
  const typeValue = arg.$.value;
  if (!typeValue) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected type value for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg,
      )}`,
    });
  }

  expr.$ = {
    env: arg.$.env,
    type: createComptStringType(),
    value: createUnknownValue(createComptStringType()), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isTypeValue(typeValue)) {
    expr.$.value = createComptStringValue(typeToString(typeValue.value));
  }
  return expr;
}

/**
 * Check if two types are compatible
 */
export function evaluateYoAreTypesCompatible({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const args = expr.args;
  const expectedTypeArg = args[0]!;
  const givenTypeArg = args[1]!;

  const evaluatedExpectedTypeArg = evaluateExpression({
    expr: expectedTypeArg,
    env,
    context: {
      ...context,
      expectedType: undefined,
      SelfType: undefined,
    },
  });
  if (!isTypeValue(evaluatedExpectedTypeArg.$?.value)) {
    throw formatErrorMessage({
      token: expectedTypeArg.token,
      errorMessage: `Expected type, got:\n${exprToString(expectedTypeArg)}`,
    });
  }
  const expectedType = evaluatedExpectedTypeArg.$.value.value;
  env = evaluatedExpectedTypeArg.$.env;

  const evaluatedGivenTypeArg = evaluateExpression({
    expr: givenTypeArg,
    env,
    context: {
      ...context,
      expectedType: undefined,
      SelfType: undefined,
    },
  });
  if (!isTypeValue(evaluatedGivenTypeArg.$?.value)) {
    throw formatErrorMessage({
      token: givenTypeArg.token,
      errorMessage: `Expected type, got:\n${exprToString(givenTypeArg)}`,
    });
  }
  const givenType = evaluatedGivenTypeArg.$.value.value;
  env = evaluatedGivenTypeArg.$.env;

  // Check if the types are compatible
  const compatible = areTypesCompatible(
    { type: expectedType, env },
    { type: givenType, env },
  );

  // Attach info to the expr
  const booleanValue = createBooleanValue(compatible);
  expr.$ = {
    env,
    type: booleanValue.type,
    value: booleanValue,
    pathCollection: [],
  };
  return expr;
}

export function evaluateYoTypeContainsRcType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_type_contains_rc_type,
    1,
  );

  const arg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });
  if (!arg.$) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        arg,
      )}`,
    });
  }
  if (!isTypeHierarchyType(arg.$.type)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected TypeHierarchy type for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg,
      )}`,
    });
  }
  const typeValue = arg.$.value;
  if (!typeValue || !isTypeValue(typeValue)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected type value for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg,
      )}`,
    });
  }

  const flag = typeContainsRcType(typeValue.value);
  const value = createBooleanValue(flag);

  expr.$ = {
    env: arg.$.env,
    type: value.type,
    value: value,
    pathCollection: [],
    isAccessingProperty: false,
  };

  return expr;
}

export function evaluateYoTypeCanFormRcCycle({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_type_can_form_rc_cycle,
    1,
  );

  const arg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });
  if (!arg.$) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        arg,
      )}`,
    });
  }
  if (!isTypeHierarchyType(arg.$.type)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected TypeHierarchy type for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg,
      )}`,
    });
  }
  const typeValue = arg.$.value;
  if (!typeValue || !isTypeValue(typeValue)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected type value for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg,
      )}`,
    });
  }

  const flag = canTypeFormRcCycle(typeValue.value);
  const value = createBooleanValue(flag);

  expr.$ = {
    env: arg.$.env,
    type: value.type,
    value: value,
    pathCollection: [],
    isAccessingProperty: false,
  };

  return expr;
}

/**
 * Check if a type implements a module.
 * Usage: __yo_type_impls(SomeType, SomeModule)
 * Returns: compt(bool)
 *
 * This checks if the type's module has a field whose assignedValue is a ModuleValue
 * that structurally matches the given module (with the type as the receiver).
 */
export function evaluateYoTypeImpls({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_type_impls, 2);

  // Evaluate the first argument (the type to check)
  const typeArg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });
  if (!typeArg.$) {
    throw formatErrorMessage({
      token: typeArg.token,
      errorMessage: `Failed to evaluate the type argument for "${expr.func.token.value}":\n${exprToString(
        typeArg,
      )}`,
    });
  }
  if (!isTypeHierarchyType(typeArg.$.type)) {
    throw formatErrorMessage({
      token: typeArg.token,
      errorMessage: `Expected Type for first argument of "${expr.func.token.value}", got:\n${exprToString(
        typeArg,
      )}`,
    });
  }
  const typeValue = typeArg.$.value;
  if (!typeValue || !isTypeValue(typeValue)) {
    throw formatErrorMessage({
      token: typeArg.token,
      errorMessage: `Expected type value for first argument of "${expr.func.token.value}", got:\n${exprToString(
        typeArg,
      )}`,
    });
  }
  env = typeArg.$.env;
  const targetType = typeValue.value;

  // Evaluate the second argument (the module to check for)
  const moduleArg = evaluateExpression({
    expr: expr.args[1]!,
    env,
    context: {
      ...context,
    },
  });
  if (!moduleArg.$) {
    throw formatErrorMessage({
      token: moduleArg.token,
      errorMessage: `Failed to evaluate the module argument for "${expr.func.token.value}":\n${exprToString(
        moduleArg,
      )}`,
    });
  }

  // The module argument should be a type value containing a module type
  // Or it could be the module type directly (when passed as a compt parameter)
  // If the argument is a compile-time unknown (Type hierarchy), return unknown bool
  let expectedModuleType: ModuleType;

  if (isTypeValue(moduleArg.$.value)) {
    const moduleTypeValue = moduleArg.$.value;
    if (!isModuleType(moduleTypeValue.value)) {
      throw formatErrorMessage({
        token: moduleArg.token,
        errorMessage: `Expected module type for second argument of "${expr.func.token.value}", got a non-module type`,
      });
    }
    expectedModuleType = moduleTypeValue.value;
  } else if (isModuleType(moduleArg.$.type)) {
    // The argument is a module type itself (the type of the value is ModuleType)
    expectedModuleType = moduleArg.$.type;
  } else if (isTypeHierarchyType(moduleArg.$.type)) {
    // The argument is a compile-time unknown (e.g., a generic parameter like `marker: Module`)
    // Return an unknown bool value - the actual check will happen when called with concrete types
    expr.$ = {
      env: moduleArg.$.env,
      type: createBooleanType(),
      value: createUnknownValue(createBooleanType()),
      pathCollection: [],
      isAccessingProperty: false,
    };
    return expr;
  } else {
    throw formatErrorMessage({
      token: moduleArg.token,
      errorMessage: `Expected module type for second argument of "${expr.func.token.value}", got:\n${exprToString(
        moduleArg,
      )}`,
    });
  }
  env = moduleArg.$.env;

  // Create a version of the expected module with targetType as the receiver
  const expectedModuleWithReceiver: ModuleType = {
    ...expectedModuleType,
    receiverType: targetType,
  };

  // Check if the target type's module has a field that implements the expected module
  let impls = false;
  const targetModule = targetType.module;
  if (targetModule) {
    for (const field of targetModule.fields) {
      if (!field.assignedValue || !isModuleValue(field.assignedValue)) {
        continue;
      }

      const fieldModuleValue = field.assignedValue;
      const fieldModuleType = fieldModuleValue.type;

      // Check if this field's module type is compatible with the expected module
      // The field module should have the target type as its receiver
      if (
        areTypesCompatible(
          { type: expectedModuleWithReceiver, env },
          { type: fieldModuleType, env },
        )
      ) {
        impls = true;
        break;
      }
    }
  }

  // If no direct impl found, check for generic impls
  if (!impls) {
    const matchingGenericImpl = findMatchingGenericImpl({
      concreteType: targetType,
      moduleType: expectedModuleType,
      env,
    });
    if (matchingGenericImpl) {
      impls = true;
    }
  }

  const value = createBooleanValue(impls);

  expr.$ = {
    env,
    type: value.type,
    value: value,
    pathCollection: [],
    isAccessingProperty: false,
  };

  return expr;
}
