import {
  addVariableToEnv,
  type Environment,
  getVariablesFromEnv,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  type Expr,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { PlaceholderToken } from "../../token";
import { createType0 } from "../../types/creators";
import type { EnumType, Type } from "../../types/definitions";
import {
  isArrayType,
  isFunctionType,
  isIsoType,
  isTupleType,
} from "../../types/guards";
import { typeToString } from "../../types/utils";
import { VUnit } from "../../unit-value";
import {
  createTypeValue,
  isFunctionValue,
  isNumberValue,
  isTypeValue,
} from "../../value";
import { evaluateComptimeFunctionCall } from "../calls/comptime-fn";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Helper function to construct Option(T) type by calling the compile-time Option function.
 */
export function createOptionType(
  innerType: Type,
  env: Environment,
  context: EvaluatorContext
): { optionType: EnumType; env: Environment } {
  // Look up the Option type constructor from environment
  const optionVariables = getVariablesFromEnv(env, "Option");
  const optionVariable = optionVariables.find(
    (v) => v.value?.[0] && isFunctionValue(v.value[0]) && isFunctionType(v.type)
  );

  if (
    !optionVariable ||
    !optionVariable.value?.[0] ||
    !isFunctionValue(optionVariable.value[0])
  ) {
    throw new Error(`Cannot find Option type constructor in environment`);
  }

  const optionFunctionValue = optionVariable.value[0];
  const optionFunctionType = optionFunctionValue.type;

  // Option :: (fn(comptime(V) : Type) -> comptime(Type))
  // We need to create a calleeEnv with the parameter V added
  const parameter = optionFunctionType.parameters[0]!;
  const innerTypeValue = createTypeValue(innerType);

  // Push new frame on top of the function's environment
  const calleeEnv = pushEnvFrame(optionFunctionType.env);

  // Add parameter V to calleeEnv
  const { env: calleeEnvWithParam } = addVariableToEnv({
    env: calleeEnv,
    variable: {
      name: parameter.label,
      token: PlaceholderToken,
      type: innerTypeValue.type,
      isCompileTimeOnly: true,
      initializedAtToken: PlaceholderToken,
      consumedAtToken: undefined,
      value: [innerTypeValue],
      isOwningTheRcValue: false,
    },
  });

  // Call Option(innerType) to get Option(innerType) type
  const { value: optionTypeValue, callerEnv: nextEnv } =
    evaluateComptimeFunctionCall({
      functionCalleeExpr: undefined,
      functionType: optionFunctionType,
      functionValue: optionFunctionValue,
      argValues: {
        forallArgs: [],
        args: [
          {
            value: innerTypeValue,
            parameterType: parameter.type,
            argType: createType0(),
          },
        ],
        variadicArgs: [],
      },
      callerEnv: env,
      calleeEnv: calleeEnvWithParam,
      context,
    });

  if (!isTypeValue(optionTypeValue)) {
    throw new Error(`Option type constructor did not return a type value`);
  }

  return {
    optionType: optionTypeValue.value as EnumType,
    env: nextEnv,
  };
}

/**
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoDecrRc({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_decr_rc[0]!], 1);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_decr_rc[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoIncrRc({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_incr_rc[0]!]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_incr_rc[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Atomic increment for Iso types. Just evaluates the argument and returns unit.
 */
export function evaluateYoIncrRcAtomic({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [
    BuiltinFunctions.__yo_incr_rc_atomic[0]!,
  ]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_incr_rc_atomic[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Atomic decrement for Iso types. Just evaluates the argument and returns unit.
 */
export function evaluateYoDecrRcAtomic({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [
    BuiltinFunctions.__yo_decr_rc_atomic[0]!,
  ]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_decr_rc_atomic[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Just evaluates the argument and returns argument.
 * Don't attach temp variable here, as this function is used to transfer
 * the ownership of the reference counted value to the caller.
 */
export function evaluateYoRcOwn({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_rc_own[0]!]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_incr_rc[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: evaluatedArgExpr.$.type,
    value: undefined,
    pathCollection: [],
  };

  // NOTE: Don't attach temp variable here.

  return expr;
}

/**
 * Evaluates __yo_dyn_drop builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoDynVtableDrop({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_dyn_drop[0]!]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_dyn_drop[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates __yo_dyn_dup builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoDynVtableDup({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_dyn_dup[0]!]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_dyn_dup[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates __yo_sometype_drop builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoSomeTypeDrop({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_sometype_drop[0]!]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_sometype_drop[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates __yo_sometype_dup builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoSomeTypeDup({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_sometype_dup[0]!]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_sometype_dup[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Extract the inner value from an Iso(T) type.
 * Returns Option(T) - .Some(value) on first extraction, .None on subsequent attempts.
 *
 * Example:
 *   iso := Iso(Box(i32))(box(42));
 *   opt := __yo_iso_extract(iso);  // opt : Option(Box(i32))
 */
export function evaluateYoIsoExtract({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(
    expr,
    [BuiltinFunctions.__yo_iso_extract[0]!],
    1
  );

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_iso_extract[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // NOTE: Don't consume the argument. We should allow to extract multiple times,
  // returning .None on subsequent attempts.
  // Consume the argument expression
  // env = setExprAsConsumed(evaluatedArgExpr, env);

  const argType = evaluatedArgExpr.$.type;

  // Validate that the argument is an Iso type
  if (!isIsoType(argType)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `${BuiltinFunctions.__yo_iso_extract[0]!} expects an Iso type, but got: ${typeToString(argType)}`,
    });
  }

  // Get the inner type from Iso(T)
  const innerType = argType.childType;

  // Create Option(T) type
  const { optionType, env: envWithOption } = createOptionType(
    innerType,
    env,
    context
  );
  env = envWithOption;

  // The actual extraction happens at runtime
  // Return Option(T) type
  expr.$ = {
    env,
    type: optionType,
    value: undefined, // Runtime value
    pathCollection: evaluatedArgExpr.$.pathCollection || [],
  };

  attachTempVariableToExpr(expr, true);
  return expr;
}

/**
 * Evaluates __yo_iso_dispose builtin function.
 * Disposes the inner value of an Iso if it hasn't been extracted.
 * Just evaluates the argument and returns unit - the actual disposal happens at runtime.
 */
export function evaluateYoIsoDispose({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_iso_dispose[0]!]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_iso_dispose[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates __yo_arc_dispose builtin function.
 * Disposes the inner value of an Arc when ref count reaches 0.
 * Just evaluates the argument and returns unit - the actual disposal happens at runtime.
 */
export function evaluateYoArcDispose({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_arc_dispose[0]!]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_arc_dispose[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates __yo_drop_array_element builtin function.
 * Drops an array element at a specific index without creating a borrowed reference.
 * This is used internally when dropping arrays with GC-type elements.
 *
 * Usage: __yo_drop_array_element(array, index)
 *
 * This function is special because it directly drops the element in place,
 * unlike array(index) which creates a borrowed reference that can't be dropped.
 */
export function evaluateYoDropArrayElement({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(
    expr,
    [BuiltinFunctions.__yo_drop_array_element[0]!],
    2
  );

  const arrayArgExpr = expr.args[0]!;
  const indexArgExpr = expr.args[1]!;

  // Evaluate array argument
  const evaluatedArrayExpr = evaluateExpression({
    expr: arrayArgExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArrayExpr.$) {
    throw formatErrorMessage({
      token: arrayArgExpr.token,
      errorMessage: `Failed to evaluate the array argument for "${BuiltinFunctions.__yo_drop_array_element[0]!}":\n${exprToString(
        arrayArgExpr
      )}`,
    });
  }
  env = evaluatedArrayExpr.$.env;

  // Evaluate index argument
  const evaluatedIndexExpr = evaluateExpression({
    expr: indexArgExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedIndexExpr.$) {
    throw formatErrorMessage({
      token: indexArgExpr.token,
      errorMessage: `Failed to evaluate the index argument for "${BuiltinFunctions.__yo_drop_array_element[0]!}":\n${exprToString(
        indexArgExpr
      )}`,
    });
  }
  env = evaluatedIndexExpr.$.env;

  // This builtin only performs compile-time checks and returns unit
  // The actual drop operation happens in the C codegen
  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };

  return expr;
}
/**
 * Evaluates __yo_dup_array_element builtin function.
 * Dups an array element at a specific index without creating a borrowed reference.
 * This is used internally when duping arrays with GC-type elements.
 *
 * Usage: __yo_dup_array_element(array, index)
 *
 * This function is special because it directly dups the element in place,
 * unlike array(index) which creates a borrowed reference that can't be duped.
 */
export function evaluateYoDupArrayElement({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(
    expr,
    [BuiltinFunctions.__yo_dup_array_element[0]!],
    2
  );

  const arrayArgExpr = expr.args[0]!;
  const indexArgExpr = expr.args[1]!;

  // Evaluate array argument
  const evaluatedArrayExpr = evaluateExpression({
    expr: arrayArgExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArrayExpr.$) {
    throw formatErrorMessage({
      token: arrayArgExpr.token,
      errorMessage: `Failed to evaluate the array argument for "${BuiltinFunctions.__yo_dup_array_element[0]!}":\n${exprToString(
        arrayArgExpr
      )}`,
    });
  }
  env = evaluatedArrayExpr.$.env;

  // Evaluate index argument
  const evaluatedIndexExpr = evaluateExpression({
    expr: indexArgExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedIndexExpr.$) {
    throw formatErrorMessage({
      token: indexArgExpr.token,
      errorMessage: `Failed to evaluate the index argument for "${BuiltinFunctions.__yo_dup_array_element[0]!}":\n${exprToString(
        indexArgExpr
      )}`,
    });
  }
  env = evaluatedIndexExpr.$.env;

  // Get the array type to determine the return type (element type)
  const arrayType = evaluatedArrayExpr.$.type;
  if (!arrayType || !isArrayType(arrayType)) {
    throw formatErrorMessage({
      token: arrayArgExpr.token,
      errorMessage: `Expected array type for "${BuiltinFunctions.__yo_dup_array_element[0]!}"`,
    });
  }

  const elementType = arrayType.childType;

  // This builtin returns the duped element
  // The actual dup operation happens in the C codegen
  expr.$ = {
    env,
    type: elementType,
    value: undefined, // Runtime value only
    pathCollection: [],
  };

  return expr;
}

/**
 * Evaluates __yo_drop_tuple_element builtin function.
 * Drops a tuple element at a specific index without creating a borrowed reference.
 * This is used internally when dropping tuples with GC-type elements.
 *
 * Usage: __yo_drop_tuple_element(tuple, index)
 *
 * This function is special because it directly drops the element in place,
 * unlike tuple.index which creates a borrowed reference that can't be dropped.
 */
export function evaluateYoDropTupleElement({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(
    expr,
    [BuiltinFunctions.__yo_drop_tuple_element[0]!],
    2
  );

  const tupleArgExpr = expr.args[0]!;
  const indexArgExpr = expr.args[1]!;

  // Evaluate tuple argument
  const evaluatedTupleExpr = evaluateExpression({
    expr: tupleArgExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedTupleExpr.$) {
    throw formatErrorMessage({
      token: tupleArgExpr.token,
      errorMessage: `Failed to evaluate the tuple argument for "${BuiltinFunctions.__yo_drop_tuple_element[0]!}":\n${exprToString(
        tupleArgExpr
      )}`,
    });
  }
  env = evaluatedTupleExpr.$.env;

  // Evaluate index argument
  const evaluatedIndexExpr = evaluateExpression({
    expr: indexArgExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedIndexExpr.$) {
    throw formatErrorMessage({
      token: indexArgExpr.token,
      errorMessage: `Failed to evaluate the index argument for "${BuiltinFunctions.__yo_drop_tuple_element[0]!}":\n${exprToString(
        indexArgExpr
      )}`,
    });
  }
  env = evaluatedIndexExpr.$.env;

  // This builtin only performs compile-time checks and returns unit
  // The actual drop operation happens in the C codegen
  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };

  return expr;
}

/**
 * Evaluates __yo_dup_tuple_element builtin function.
 * Dups a tuple element at a specific index without creating a borrowed reference.
 * This is used internally when duping tuples with GC-type elements.
 *
 * Usage: __yo_dup_tuple_element(tuple, index)
 *
 * This function is special because it directly dups the element in place,
 * unlike tuple.index which creates a borrowed reference that can't be duped.
 */
export function evaluateYoDupTupleElement({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(
    expr,
    [BuiltinFunctions.__yo_dup_tuple_element[0]!],
    2
  );

  const tupleArgExpr = expr.args[0]!;
  const indexArgExpr = expr.args[1]!;

  // Evaluate tuple argument
  const evaluatedTupleExpr = evaluateExpression({
    expr: tupleArgExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedTupleExpr.$) {
    throw formatErrorMessage({
      token: tupleArgExpr.token,
      errorMessage: `Failed to evaluate the tuple argument for "${BuiltinFunctions.__yo_dup_tuple_element[0]!}":\n${exprToString(
        tupleArgExpr
      )}`,
    });
  }
  env = evaluatedTupleExpr.$.env;

  // Evaluate index argument
  const evaluatedIndexExpr = evaluateExpression({
    expr: indexArgExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedIndexExpr.$) {
    throw formatErrorMessage({
      token: indexArgExpr.token,
      errorMessage: `Failed to evaluate the index argument for "${BuiltinFunctions.__yo_dup_tuple_element[0]!}":\n${exprToString(
        indexArgExpr
      )}`,
    });
  }
  env = evaluatedIndexExpr.$.env;

  // Get the tuple type to determine the return type (element type)
  const tupleType = evaluatedTupleExpr.$.type;
  if (!tupleType || !isTupleType(tupleType)) {
    throw formatErrorMessage({
      token: tupleArgExpr.token,
      errorMessage: `Expected tuple type for "${BuiltinFunctions.__yo_dup_tuple_element[0]!}"`,
    });
  }

  // Get the element type from the tuple at the specified index
  const indexValue = evaluatedIndexExpr.$.value;
  if (!isNumberValue(indexValue)) {
    throw formatErrorMessage({
      token: indexArgExpr.token,
      errorMessage: `Expected number value for index in "${BuiltinFunctions.__yo_dup_tuple_element[0]!}"`,
    });
  }

  const index = Number(indexValue.value);
  if (index < 0 || index >= tupleType.fields.length) {
    throw formatErrorMessage({
      token: indexArgExpr.token,
      errorMessage: `Index out of bounds for tuple in "${BuiltinFunctions.__yo_dup_tuple_element[0]!}"`,
    });
  }

  const elementType = tupleType.fields[index]!.type;

  // This builtin returns the duped element
  // The actual dup operation happens in the C codegen
  expr.$ = {
    env,
    type: elementType,
    value: undefined, // Runtime value only
    pathCollection: [],
  };

  return expr;
}
