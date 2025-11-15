import { Expr, exprIsAtom } from "../expr";
import { TokenType } from "../token";

/**
 * Check if the expr is either an identifier or an operator
 * @param expr
 * @returns
 */
export function isValidVariableName(expr: Expr): boolean {
  return (
    (exprIsAtom(expr) && expr.token.type === TokenType.Identifier) ||
    expr.token.type === TokenType.Operator
  );
}
