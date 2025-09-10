import { checkBorrowings } from "../../borrow";
import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  Expr,
  exprIsFunctionCall,
  exprToString,
  FuncCallExpr,
  replaceFuncCallExpr,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import { isSomeType, typeContainsARCType } from "../../types";
import { VUnit } from "../../unit-value";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";

/**
 * ___dup function - simplified since we removed consumption logic.
 * Just evaluates the argument and returns unit.
 */
export function evaluateDup({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.___dup, 1);

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

  // Check if the dup argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedArgExpr);

  // Check if there is `.___dup` method available to call
  // for Linear value
  if (
    !isSomeType(evaluatedArgExpr.$.type) &&
    // isType0(evaluatedArgExpr.$.type)
    typeContainsARCType(evaluatedArgExpr.$.type)
  ) {
    const dupMethodCallExpr = generateExprFromCode(
      `(${exprToString(evaluatedArgExpr)}).___dup()`
    ) as FuncCallExpr;

    // Convert this ___dup(x) to x.___dup() and evaluate the function call
    const evaluatedDupMethodCallExpr = evaluateFunctionCall({
      env,
      context: { ...context },
      expr: dupMethodCallExpr,
    });

    // Replace the original expr with the evaluated dup method call
    if (exprIsFunctionCall(evaluatedDupMethodCallExpr)) {
      replaceFuncCallExpr(expr, evaluatedDupMethodCallExpr);
      return expr;
    } else {
      // In theory we shouldn't enter here
      return evaluatedDupMethodCallExpr;
    }
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
