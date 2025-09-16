import { Environment, getVariablesFromEnv, Variable } from "../env";
import { Expr, exprIsAtom } from "../expr";
import { TokenType } from "../token";
import { isTempVariableName } from "../utils";

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
 * Helper function to find the ARC-owning temp variable that an expression borrows from
 * @param rhs The right-hand side expression to check
 * @param env The current environment
 * @param modulePath The module path for temp variable name checking
 * @returns The variable that owns the ARC value, or undefined if not found
 */
export function findBorrowingRelationship(
  rhs: Expr,
  env: Environment,
  modulePath: string
): Variable | undefined {
  if (
    !rhs.$?.variableName ||
    !isTempVariableName(modulePath, rhs.$.variableName)
  ) {
    return undefined;
  }

  const rhsVariables = getVariablesFromEnv(env, rhs.$.variableName);
  if (rhsVariables.length === 0) {
    return undefined;
  }

  const candidate = rhsVariables[rhsVariables.length - 1]!;
  if (candidate.isOwningTheARCValue) {
    return candidate;
  }

  return undefined;
}
