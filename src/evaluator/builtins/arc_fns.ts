import { checkBorrowings } from "../../borrow";
import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  Expr,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createBooleanType } from "../../types";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";

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
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_decr_rc[0]!]);

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
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_decr_rc[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the drop argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedArgExpr);

  // Evaluate the second argument (dispose function) if provided
  const disposeFnExpr = expr.args[1];
  if (disposeFnExpr) {
    const evaluatedDisposeFnExpr = context.evaluateExpression({
      expr: disposeFnExpr,
      env,
      context: {
        ...context,
      },
    });

    if (!evaluatedDisposeFnExpr.$) {
      throw formatErrorMessage({
        token: disposeFnExpr.token,
        errorMessage: `Failed to evaluate the dispose function expression for "${BuiltinFunctions.__yo_decr_rc[0]!}":\n${exprToString(
          disposeFnExpr
        )}`,
      });
    }
    env = evaluatedDisposeFnExpr.$.env;
  }

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
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_incr_rc[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the drop argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedArgExpr);

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

export function evaluateIsUniquelyOwned({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.is_uniquely_owned, 1);

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
      errorMessage: `Failed to evaluate the argument expression for "drop":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the drop argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedArgExpr);

  expr.$ = {
    env,
    type: createBooleanType(),
    value: undefined,
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
 * Evaluates __yo_dyn_vtable_dispose builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoDynVtableDispose({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [
    BuiltinFunctions.__yo_dyn_vtable_dispose[0]!,
  ]);

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
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_dyn_vtable_dispose[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedArgExpr);

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates __yo_dyn_vtable_drop builtin function.
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
  expectExprToBeFunctionCallOf(expr, [
    BuiltinFunctions.__yo_dyn_vtable_drop[0]!,
  ]);

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
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_dyn_vtable_drop[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedArgExpr);

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates __yo_dyn_vtable_dup builtin function.
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
  expectExprToBeFunctionCallOf(expr, [
    BuiltinFunctions.__yo_dyn_vtable_dup[0]!,
  ]);

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
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_dyn_vtable_dup[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedArgExpr);

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates __yo_closure_dispose builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoClosureDispose({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [
    BuiltinFunctions.__yo_closure_dispose[0]!,
  ]);

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
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_closure_dispose[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedArgExpr);

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates __yo_closure_drop builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoClosureDrop({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_closure_drop[0]!]);

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
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_closure_drop[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedArgExpr);

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates __yo_closure_dup builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoClosureDup({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_closure_dup[0]!]);

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
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_closure_dup[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedArgExpr);

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}
