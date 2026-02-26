import { type Environment, getVariablesFromEnv, type Variable } from "../env";
import { formatErrorMessage } from "../error";
import { type Expr, exprIsAtom } from "../expr";
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
 * Find the ultimate Rc-owning variable that a RHS expression borrows from.
 * Handles chains like:
 *   temp := Box(...); // temp owns
 *   x := temp;        // x owns what temp owns
 *   y := x;           // y owns what x owns, which is what temp owns
 */
export function findRcValueOwnerRelationship(
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
  while (candidate && candidate.isOwningTheSameRcValueAs) {
    if (visited.has(candidate.id)) return undefined; // cycle guard
    visited.add(candidate.id);
    candidate = candidate.isOwningTheSameRcValueAs;
  }

  if (candidate && candidate.isOwningTheRcValue) {
    return candidate;
  }
  return undefined;
}

export function throwExprIsImplicitVariableError(rhs: Expr) {
  // Disallow using implicit variables (or property access of them) as the RHS
  // of a non-given assignment. Implicit variables must be passed via using() parameters,
  // not captured through regular assignments.
  const env = rhs.$?.env;
  if (!env) {
    return;
  }
  let variableName: string | undefined = undefined;
  if (rhs.$?.pathCollection) {
    for (const path of rhs.$.pathCollection) {
      if (path.length > 0 && typeof path[0] === "string") {
        variableName = path[0];
      }
    }
  } else if (exprIsAtom(rhs)) {
    variableName = rhs.token.value;
  }

  if (variableName) {
    const rootVars = getVariablesFromEnv(env, variableName);
    const rootVar = rootVars[rootVars.length - 1];
    if (rootVar?.isImplicit) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Cannot use implicit variable "${rootVar.name}" in assignment. Implicit variables must be passed via using() parameters.`,
      });
    }
  }
}
