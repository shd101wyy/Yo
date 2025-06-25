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
  createBooleanValue,
  createComptStringValue,
  createExprListValue,
  createExprValue,
  createUnknownValue,
  isExprValue,
} from "../../value";
import { EvaluatorContext } from "../context";

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
  const evaluatedArgExpr = context.evaluateExpression({
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
        argExpr
      )}`,
    });
  }
  if (!isExprType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }
  const exprValue = evaluatedArgExpr.$.value;
  if (!exprValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
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
    isMutable: false,
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
  const evaluatedArgExpr = context.evaluateExpression({
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
        argExpr
      )}`,
    });
  }
  if (!isExprType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }
  const exprValue = evaluatedArgExpr.$.value;
  if (!exprValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
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
    isMutable: false,
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
  const evaluatedArgExpr = context.evaluateExpression({
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
        argExpr
      )}`,
    });
  }
  if (!isExprType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }
  const exprValue = evaluatedArgExpr.$.value;
  if (!exprValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: createExprType(),
    value: createUnknownValue(createExprType()), // Will be updated later
    isMutable: false,
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
          expr
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
  const evaluatedArgExpr = context.evaluateExpression({
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
        argExpr
      )}`,
    });
  }
  if (!isExprType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }
  const exprValue = evaluatedArgExpr.$.value;
  if (!exprValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: createExprListType(),
    value: createUnknownValue(createExprListType()), // Will be updated later
    isMutable: false,
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isExprValue(exprValue)) {
    if (exprIsFunctionCall(exprValue.value)) {
      const fnArgs = exprValue.value.args;
      const fnArgsValue = createExprListValue(
        fnArgs.map((arg) => createExprValue(arg))
      );
      expr.$.value = fnArgsValue;
    } else {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected function call expression for argument, got:\n${exprToString(
          expr
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
  const evaluatedArgExpr = context.evaluateExpression({
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
        argExpr
      )}`,
    });
  }
  if (!isExprType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }
  const exprValue = evaluatedArgExpr.$.value;
  if (!exprValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected expression value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: createComptStringType(),
    value: createUnknownValue(createComptStringType()), // Will be updated later
    isMutable: false,
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isExprValue(exprValue)) {
    expr.$.value = createComptStringValue(exprToString(exprValue.value));
  }

  return expr;
}
