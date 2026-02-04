import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import {
  createBooleanType,
  createComptimeStringType,
} from "../../types/creators";
import { TraitType } from "../../types/definitions";
import { isTraitType, isTypeHierarchyType } from "../../types/guards";
import {
  canTypeFormRcCycle,
  typeContainsRcType,
  typeToString,
} from "../../types/utils";
import {
  createBooleanValue,
  createComptimeStringValue,
  createUnknownValue,
  isTypeValue,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { typeImplementsTrait } from "../trait-checking";

export function evaluateYoTypeToString({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_type_to_comptime_string,
    1
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
        arg
      )}`,
    });
  }
  if (!isTypeHierarchyType(arg.$.type)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected TypeHierarchy type for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg
      )}`,
    });
  }
  const typeValue = arg.$.value;
  if (!typeValue) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected type value for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg
      )}`,
    });
  }

  expr.$ = {
    env: arg.$.env,
    type: createComptimeStringType(),
    value: createUnknownValue(createComptimeStringType(), {
      env: arg.$.env,
      context,
    }), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isTypeValue(typeValue)) {
    expr.$.value = createComptimeStringValue(typeToString(typeValue.value));
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
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
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
    { type: givenType, env }
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
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_type_contains_rc_type,
    1
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
        arg
      )}`,
    });
  }
  if (!isTypeHierarchyType(arg.$.type)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected TypeHierarchy type for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg
      )}`,
    });
  }
  const typeValue = arg.$.value;
  if (!typeValue || !isTypeValue(typeValue)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected type value for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg
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
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_type_can_form_rc_cycle,
    1
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
        arg
      )}`,
    });
  }
  if (!isTypeHierarchyType(arg.$.type)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected TypeHierarchy type for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg
      )}`,
    });
  }
  const typeValue = arg.$.value;
  if (!typeValue || !isTypeValue(typeValue)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected type value for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg
      )}`,
    });
  }

  const flag = canTypeFormRcCycle(typeValue.value, new Set(), arg.$.env);
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
 * Check if a type implements a trait.
 * Usage: __yo_type_impls(SomeType, SomeTrait)
 * Returns: comptime(bool)
 *
 * This checks if the type's trait has a field whose assignedValue is a ModuleValue
 * that structurally matches the given trait (with the type as the receiver).
 */
export function evaluateYoTypeImpls({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
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
        typeArg
      )}`,
    });
  }
  if (!isTypeHierarchyType(typeArg.$.type)) {
    throw formatErrorMessage({
      token: typeArg.token,
      errorMessage: `Expected Type for first argument of "${expr.func.token.value}", got:\n${exprToString(
        typeArg
      )}`,
    });
  }
  const typeValue = typeArg.$.value;
  if (!typeValue || !isTypeValue(typeValue)) {
    throw formatErrorMessage({
      token: typeArg.token,
      errorMessage: `Expected type value for first argument of "${expr.func.token.value}", got:\n${exprToString(
        typeArg
      )}`,
    });
  }
  env = typeArg.$.env;
  const targetType = typeValue.value;

  // Evaluate the second argument (the trait to check for)
  const traitArg = evaluateExpression({
    expr: expr.args[1]!,
    env,
    context: {
      ...context,
    },
  });
  if (!traitArg.$) {
    throw formatErrorMessage({
      token: traitArg.token,
      errorMessage: `Failed to evaluate the trait argument for "${expr.func.token.value}":\n${exprToString(
        traitArg
      )}`,
    });
  }

  // The trait argument should be a type value containing a trait type
  // Or it could be the trait type directly (when passed as a comptime parameter)
  // If the argument is a compile-time unknown (Type hierarchy), return unknown bool
  let expectedTraitType: TraitType;

  if (isTypeValue(traitArg.$.value)) {
    const traitTypeValue = traitArg.$.value;
    if (!isTraitType(traitTypeValue.value)) {
      throw formatErrorMessage({
        token: traitArg.token,
        errorMessage: `Expected trait type for second argument of "${expr.func.token.value}", got a non-trait type`,
      });
    }
    expectedTraitType = traitTypeValue.value;
  } else if (isTraitType(traitArg.$.type)) {
    // The argument is a trait type itself (the type of the value is TraitType)
    expectedTraitType = traitArg.$.type;
  } else if (isTypeHierarchyType(traitArg.$.type)) {
    // The argument is a compile-time unknown (e.g., a generic parameter like `marker: Trait`)
    // Return an unknown bool value - the actual check will happen when called with concrete types
    expr.$ = {
      env: traitArg.$.env,
      type: createBooleanType(),
      value: createUnknownValue(createBooleanType(), {
        env: traitArg.$.env,
        context,
      }),
      pathCollection: [],
      isAccessingProperty: false,
    };
    return expr;
  } else {
    throw formatErrorMessage({
      token: traitArg.token,
      errorMessage: `Expected trait type for second argument of "${expr.func.token.value}", got:\n${exprToString(
        traitArg
      )}`,
    });
  }
  env = traitArg.$.env;

  const value = createBooleanValue(
    typeImplementsTrait({ targetType, traitType: expectedTraitType, env })
  );

  expr.$ = {
    env,
    type: value.type,
    value: value,
    pathCollection: [],
    isAccessingProperty: false,
  };

  return expr;
}
