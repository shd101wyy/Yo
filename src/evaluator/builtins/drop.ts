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
  replaceFuncCallExprWithFuncCallExpr,
  setExprAsConsumed,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import { isSomeType, typeContainsARCType } from "../../types";
import { VUnit } from "../../unit-value";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";

/**
 * ___drop function - simplified since we removed consumption logic.
 * Just evaluates the argument and returns unit.
 */
export function evaluateDrop({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.___drop, 1);

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

  // Check if there is `.___drop` method available to call
  // for Linear value
  if (
    !isSomeType(evaluatedArgExpr.$.type) &&
    // isType0(evaluatedArgExpr.$.type)
    typeContainsARCType(evaluatedArgExpr.$.type)
  ) {
    const dropMethodCallExpr = generateExprFromCode(
      `(${exprToString(evaluatedArgExpr)}).___drop()`
    ) as FuncCallExpr;

    // Set the expression as consumed
    env = setExprAsConsumed(evaluatedArgExpr, env, context);

    // Convert this ___drop(x) to x.___drop() and evaluate the function call
    const evaluatedDropMethodCallExpr = evaluateFunctionCall({
      env,
      context: { ...context },
      expr: dropMethodCallExpr,
    });

    // Replace the original expr with the evaluated drop method call
    if (exprIsFunctionCall(evaluatedDropMethodCallExpr)) {
      replaceFuncCallExprWithFuncCallExpr(expr, evaluatedDropMethodCallExpr);
      return expr;
    } else {
      // In theory we shouldn't enter here
      return evaluatedDropMethodCallExpr;
    }
  } else {
    // Set the expression as consumed
    env = setExprAsConsumed(evaluatedArgExpr, env, context);

    // TODO: Handle calling drop function.
    // In theory, the Free values will be ignored.

    expr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
}
