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
      errorMessage: `Failed to evaluate the argument expression for "drop":\n${exprToString(
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
        errorMessage: `Failed to evaluate the dispose function expression for "__yo_decr_rc":\n${exprToString(
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
    isMutable: false,
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
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
