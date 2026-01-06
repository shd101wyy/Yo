import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprIsAtom,
  exprIsFunctionCall,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  createBooleanType,
  createComptStringType,
  createExprListType,
  createExprType,
  isExprType,
} from "../../types";
import {
  areValuesEqual,
  BooleanValue,
  createBooleanValue,
  createComptListValue,
  createComptStringValue,
  createExprValue,
  createUnknownValue,
  isExprValue,
  UnknownValue,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateYoExprIsAtom({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_expr_is_atom, 1);

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
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        argExpr,
      )}`,
    });
  }
  if (!isExprType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }
  const exprValue = evaluatedArgExpr.$.value;
  if (!exprValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }

  const booleanValue = isExprValue(exprValue)
    ? createBooleanValue(exprIsAtom(exprValue.value))
    : createUnknownValue(createBooleanType());

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: booleanValue.type,
    value: booleanValue,
    pathCollection: [],
    isAccessingProperty: false,
  };
  return expr;
}

export function evaluateYoExprIsFnCall({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_expr_is_fn_call, 1);

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
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        argExpr,
      )}`,
    });
  }
  if (!isExprType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }
  const exprValue = evaluatedArgExpr.$.value;
  if (!exprValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }

  const booleanValue = isExprValue(exprValue)
    ? createBooleanValue(exprIsFunctionCall(exprValue.value))
    : createUnknownValue(createBooleanType());

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: booleanValue.type,
    value: booleanValue,
    pathCollection: [],
    isAccessingProperty: false,
  };
  return expr;
}

export function evaluateYoExprGetCallee({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_expr_get_callee, 1);

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
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        argExpr,
      )}`,
    });
  }
  if (!isExprType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }
  const exprValue = evaluatedArgExpr.$.value;
  if (!exprValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: createExprType(),
    value: createUnknownValue(createExprType()), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isExprValue(exprValue)) {
    if (exprIsFunctionCall(exprValue.value)) {
      const fn = exprValue.value.func;
      const fnExprValue = createExprValue(fn);
      expr.$.value = fnExprValue;
    } else {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected function call expression for argument, got:\n${exprToString(
          expr,
        )}`,
      });
    }
  }

  return expr;
}

export function evaluateYoExprGetArgs({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_expr_get_args, 1);

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
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        argExpr,
      )}`,
    });
  }
  if (!isExprType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }
  const exprValue = evaluatedArgExpr.$.value;
  if (!exprValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: createExprListType(),
    value: createUnknownValue(createExprListType()), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isExprValue(exprValue)) {
    if (exprIsFunctionCall(exprValue.value)) {
      const fnArgs = exprValue.value.args;
      const fnArgsValue = createComptListValue(
        createExprType(),
        fnArgs.map((arg) => createExprValue(arg)),
      );
      expr.$.value = fnArgsValue;
    } else {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected function call expression for argument, got:\n${exprToString(
          expr,
        )}`,
      });
    }
  }

  return expr;
}

export function evaluateYoExprToString({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_expr_to_string, 1);

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
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        argExpr,
      )}`,
    });
  }
  if (!isExprType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }
  const exprValue = evaluatedArgExpr.$.value;
  if (!exprValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: createComptStringType(),
    value: createUnknownValue(createComptStringType()), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isExprValue(exprValue)) {
    expr.$.value = createComptStringValue(exprToString(exprValue.value));
  }

  return expr;
}

export function evaluateYoExprEq({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_expr_eq, 2);

  const firstArgExpr = expr.args[0]!;
  const secondArgExpr = expr.args[1]!;

  // Evaluate first argument
  const evaluatedFirstArgExpr = evaluateExpression({
    expr: firstArgExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedFirstArgExpr.$) {
    throw formatErrorMessage({
      token: firstArgExpr.token,
      errorMessage: `Failed to evaluate the first argument expression for "${expr.func.token.value}":\n${exprToString(
        firstArgExpr,
      )}`,
    });
  }
  if (!isExprType(evaluatedFirstArgExpr.$.type)) {
    throw formatErrorMessage({
      token: firstArgExpr.token,
      errorMessage: `Expected expression type for "${expr.func.token.value}" first argument, got:\n${exprToString(
        firstArgExpr,
      )}`,
    });
  }
  const firstExprValue = evaluatedFirstArgExpr.$.value;
  if (!firstExprValue) {
    throw formatErrorMessage({
      token: firstArgExpr.token,
      errorMessage: `Expected expression value for "${expr.func.token.value}" first argument, got:\n${exprToString(
        firstArgExpr,
      )}`,
    });
  }
  env = evaluatedFirstArgExpr.$.env;

  // Evaluate second argument
  const evaluatedSecondArgExpr = evaluateExpression({
    expr: secondArgExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedSecondArgExpr.$) {
    throw formatErrorMessage({
      token: secondArgExpr.token,
      errorMessage: `Failed to evaluate the second argument expression for "${expr.func.token.value}":\n${exprToString(
        secondArgExpr,
      )}`,
    });
  }
  if (!isExprType(evaluatedSecondArgExpr.$.type)) {
    throw formatErrorMessage({
      token: secondArgExpr.token,
      errorMessage: `Expected expression type for "${expr.func.token.value}" second argument, got:\n${exprToString(
        secondArgExpr,
      )}`,
    });
  }
  const secondExprValue = evaluatedSecondArgExpr.$.value;
  if (!secondExprValue) {
    throw formatErrorMessage({
      token: secondArgExpr.token,
      errorMessage: `Expected expression value for "${expr.func.token.value}" second argument, got:\n${exprToString(
        secondArgExpr,
      )}`,
    });
  }
  env = evaluatedSecondArgExpr.$.env;

  // Check if both are ExprValue and compare their expressions
  let value: BooleanValue | UnknownValue;
  if (isExprValue(firstExprValue) && isExprValue(secondExprValue)) {
    value = createBooleanValue(
      areValuesEqual(
        { value: firstExprValue, env },
        { value: secondExprValue, env },
      ),
    );
  } else {
    value = createUnknownValue(createBooleanType()) as UnknownValue;
  }

  expr.$ = {
    env: env,
    type: value.type,
    value: value,
    pathCollection: [],
    isAccessingProperty: false,
  };

  return expr;
}
