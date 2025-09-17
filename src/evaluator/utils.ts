import { Environment, getVariablesFromEnv, Variable } from "../env";
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

/**
 * Find the ultimate ARC-owning variable that a RHS expression borrows from.
 * Handles chains like:
 *   temp := Box(...); // temp owns
 *   x := temp;        // x borrows temp
 *   y := x;           // y borrows temp (should point to temp, not x)
 */
export function findBorrowingRelationship(
  rhs: Expr,
  env: Environment,
  _modulePath: string
): Variable | undefined {
  if (!rhs.$?.variableName) {
    return undefined;
  }

  const vars = getVariablesFromEnv(env, rhs.$.variableName);
  if (!vars.length) return undefined;

  let candidate = vars[vars.length - 1]!;

  // Follow the borrowing chain until we reach an owning variable or it breaks.
  const visited = new Set<string>();
  while (candidate && !candidate.isOwningTheARCValue) {
    if (!candidate.isBorrowingTheARCValueOfVariable) return undefined;
    if (visited.has(candidate.id)) return undefined; // cycle guard
    visited.add(candidate.id);
    candidate = candidate.isBorrowingTheARCValueOfVariable;
  }

  if (candidate && candidate.isOwningTheARCValue) {
    return candidate;
  }
  return undefined;
}
