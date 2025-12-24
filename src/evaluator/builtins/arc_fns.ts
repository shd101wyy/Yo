import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  Expr,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { PlaceholderToken } from "../../token";
import {
  createType0,
  EnumType,
  isFunctionType,
  isIsoType,
  Type,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { createTypeValue, isFunctionValue, isTypeValue } from "../../value";
import { evaluateComptFunctionCall } from "../calls/compt_function";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Helper function to construct Option(T) type by calling the compile-time Option function.
 */
function createOptionType(
  innerType: Type,
  env: Environment,
  context: EvaluatorContext
): { optionType: EnumType; env: Environment } {
  // Look up the Option type constructor from environment
  const optionVariables = getVariablesFromEnv(env, "Option");
  const optionVariable = optionVariables.find(
    (v) => v.value && isFunctionValue(v.value) && isFunctionType(v.type)
  );

  if (
    !optionVariable ||
    !optionVariable.value ||
    !isFunctionValue(optionVariable.value)
  ) {
    throw new Error(`Cannot find Option type constructor in environment`);
  }

  const optionFunctionValue = optionVariable.value;
  const optionFunctionType = optionFunctionValue.type;

  // Option :: (fn(compt(V) : Type) -> compt(Type))
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
      value: innerTypeValue,
      isOwningTheGcValue: false,
    },
  });

  // Call Option(innerType) to get Option(innerType) type
  const { value: optionTypeValue, callerEnv: nextEnv } =
    evaluateComptFunctionCall({
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
  expr: FuncCallExpr;
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
  expr: FuncCallExpr;
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
  expr: FuncCallExpr;
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
  expr: FuncCallExpr;
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
  expr: FuncCallExpr;
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
  expr: FuncCallExpr;
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
  expr: FuncCallExpr;
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
  expr: FuncCallExpr;
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
  expr: FuncCallExpr;
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
  expr: FuncCallExpr;
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

  return expr;
}
