import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  createExprListType,
  createExprType,
  createUsizeType,
  isExprListType,
  isExprType,
} from "../../types";
import {
  createExprListValue,
  createNumberValue,
  createUnknownValue,
  isExprListValue,
  isExprValue,
} from "../../value";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";

export function evaluateYoExprListCar({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_car, 1);

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
  if (!isExprListType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ExprList type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }
  const exprValue = evaluatedArgExpr.$.value;
  if (!exprValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ExprList value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: createExprType(),
    value: createUnknownValue(createExprType()), // Will be updated later
    isMutable: false,

    isAccessingProperty: false,
  };

  if (isExprListValue(exprValue)) {
    const elements = exprValue.elements;
    if (elements.length > 0) {
      expr.$.value = elements[0]!;
    } else {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Unexpected empty ExprList for "${expr.func.token.value}" argument`,
      });
    }
  }

  return expr;
}

export function evaluateYoExprListCdr({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_cdr, 1);

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
  if (!isExprListType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ExprList type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }
  const exprValue = evaluatedArgExpr.$.value;
  if (!exprValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ExprList value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: createExprListType(),
    value: createUnknownValue(createExprListType()), // Will be updated later
    isMutable: false,

    isAccessingProperty: false,
  };

  if (isExprListValue(exprValue)) {
    const elements = exprValue.elements;
    if (elements.length > 0) {
      expr.$.value = createExprListValue([...elements.slice(1)]);
    } else {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Unexpected empty ExprList for "${expr.func.token.value}" argument`,
      });
    }
  }

  return expr;
}

export function evaluateYoExprListCons({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_cons, 2);

  const carArg = context.evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });

  // car
  if (!carArg.$) {
    throw formatErrorMessage({
      token: carArg.token,
      errorMessage: `Failed to evaluate the first argument expression for "${expr.func.token.value}":\n${exprToString(
        carArg
      )}`,
    });
  }
  env = carArg.$.env;
  if (!isExprType(carArg.$.type)) {
    throw formatErrorMessage({
      token: carArg.token,
      errorMessage: `Expected Expr type for "${expr.func.token.value}" first argument, got:\n${exprToString(
        carArg
      )}`,
    });
  }
  const carValue = carArg.$.value;
  if (!carValue) {
    throw formatErrorMessage({
      token: carArg.token,
      errorMessage: `Expected Expr value for "${expr.func.token.value}" first argument, got:\n${exprToString(
        carArg
      )}`,
    });
  }

  const cdrArg = context.evaluateExpression({
    expr: expr.args[1]!,
    env,
    context: {
      ...context,
    },
  });
  if (!cdrArg.$) {
    throw formatErrorMessage({
      token: cdrArg.token,
      errorMessage: `Failed to evaluate the second argument expression for "${expr.func.token.value}":\n${exprToString(
        cdrArg
      )}`,
    });
  }
  env = cdrArg.$.env;
  if (!isExprListType(cdrArg.$.type)) {
    throw formatErrorMessage({
      token: cdrArg.token,
      errorMessage: `Expected ExprList type for "${expr.func.token.value}" second argument, got:\n${exprToString(
        cdrArg
      )}`,
    });
  }
  const cdrValue = cdrArg.$.value;
  if (!cdrValue) {
    throw formatErrorMessage({
      token: cdrArg.token,
      errorMessage: `Expected ExprList value for "${expr.func.token.value}" second argument, got:\n${exprToString(
        cdrArg
      )}`,
    });
  }

  expr.$ = {
    env: env,
    type: createExprListType(),
    value: createUnknownValue(createExprListType()), // Will be updated later
    isMutable: false,

    isAccessingProperty: false,
  };

  if (isExprValue(carValue)) {
    if (isExprListValue(cdrValue)) {
      // Create a new ExprListValue with the car as the first element
      const newElements = [carValue, ...cdrValue.elements];
      expr.$.value = createExprListValue(newElements);
    } else {
      // cdrValue is unknown
    }
  } else {
    // unknown value;
  }

  return expr;
}

export function evaluateYoExprListAppend({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_append, 2);

  const firstListArg = context.evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });

  // car
  if (!firstListArg.$) {
    throw formatErrorMessage({
      token: firstListArg.token,
      errorMessage: `Failed to evaluate the first argument expression for "${expr.func.token.value}":\n${exprToString(
        firstListArg
      )}`,
    });
  }
  env = firstListArg.$.env;
  if (!isExprListType(firstListArg.$.type)) {
    throw formatErrorMessage({
      token: firstListArg.token,
      errorMessage: `Expected ExprList type for "${expr.func.token.value}" first argument, got:\n${exprToString(
        firstListArg
      )}`,
    });
  }
  const firstListValue = firstListArg.$.value;
  if (!firstListValue) {
    throw formatErrorMessage({
      token: firstListArg.token,
      errorMessage: `Expected Expr value for "${expr.func.token.value}" first argument, got:\n${exprToString(
        firstListArg
      )}`,
    });
  }

  const secondListArg = context.evaluateExpression({
    expr: expr.args[1]!,
    env,
    context: {
      ...context,
    },
  });
  if (!secondListArg.$) {
    throw formatErrorMessage({
      token: secondListArg.token,
      errorMessage: `Failed to evaluate the second argument expression for "${expr.func.token.value}":\n${exprToString(
        secondListArg
      )}`,
    });
  }
  env = secondListArg.$.env;
  if (!isExprListType(secondListArg.$.type)) {
    throw formatErrorMessage({
      token: secondListArg.token,
      errorMessage: `Expected ExprList type for "${expr.func.token.value}" second argument, got:\n${exprToString(
        secondListArg
      )}`,
    });
  }
  const secondListValue = secondListArg.$.value;
  if (!secondListValue) {
    throw formatErrorMessage({
      token: secondListArg.token,
      errorMessage: `Expected ExprList value for "${expr.func.token.value}" second argument, got:\n${exprToString(
        secondListArg
      )}`,
    });
  }

  expr.$ = {
    env: env,
    type: createExprListType(),
    value: createUnknownValue(createExprListType()), // Will be updated later
    isMutable: false,

    isAccessingProperty: false,
  };

  if (isExprListValue(firstListValue)) {
    if (isExprListValue(secondListValue)) {
      // merge two ExprList values
      const newElements = [
        ...firstListValue.elements,
        ...secondListValue.elements,
      ];
      expr.$.value = createExprListValue(newElements);
    } else {
      // cdrValue is unknown
    }
  } else {
    // unknown value;
  }

  return expr;
}

export function evaluateYoExprListLength({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_length, 1);

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
  if (!isExprListType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ExprList type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }
  const exprListValue = evaluatedArgExpr.$.value;
  if (!exprListValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ExprList value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: createUsizeType(),
    value: createUnknownValue(createUsizeType()), // Will be updated later
    isMutable: false,

    isAccessingProperty: false,
  };

  if (isExprListValue(exprListValue)) {
    const length = exprListValue.elements.length;
    const lengthValue = createNumberValue(ValueTag.Usize, length);
    expr.$.value = lengthValue;
  }

  return expr;
}
