import { checkBorrowings } from "../../borrow";
import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  Expr,
  ExprTag,
  exprToString,
  FuncCallExpr,
  setExprAsConsumed,
} from "../../expr";
import { TokenType } from "../../token";
import { isLinearOrType0Type, isSomeType } from "../../types";
import { VUnit } from "../../unit-value";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";

/**
 * Explicitly drop a value.
 * This function is related with RAII.
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

  // Check if there is `.drop` method available to call
  // for Linear value
  if (
    !isSomeType(evaluatedArgExpr.$.type) &&
    isLinearOrType0Type(evaluatedArgExpr.$.type)
  ) {
    const dropMethodCallExpr: FuncCallExpr = {
      tag: ExprTag.FuncCall,
      args: [],
      token: expr.token,
      func: {
        tag: ExprTag.FuncCall,
        token: {
          type: TokenType.Dot,
          value: ".",
          inputString: expr.token.inputString,
          modulePath: expr.token.modulePath,
          position: expr.func.token.position,
        },
        args: [evaluatedArgExpr, expr.func],
        func: {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Dot,
            value: ".",
            inputString: expr.token.inputString,
            modulePath: expr.token.modulePath,
            position: expr.func.token.position,
          },
        },
        isInfix: true,
      },
    };
    // Convert this drop(x) to x.drop() and evaluate the function call
    return evaluateFunctionCall({
      env,
      context: { ...context },
      expr: dropMethodCallExpr,
    });
  }

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
