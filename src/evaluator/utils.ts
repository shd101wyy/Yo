import { type Environment, getVariablesFromEnv, type Variable } from "../env";
import {
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
} from "../expr";
import { TokenType } from "../token";
import type { Type } from "../types/definitions";
import { getValueOfSomeTypeFromEnv } from "../types/env-lookup";
import { isAtomicReferenceStructType, isSomeType } from "../types/guards";

/**
 * Phase O (THREAD_SAFETY): Walk a field-access expression to find the root
 * sub-expression before the first `.` access.
 *
 * For `a.b.c`, returns the expression for `a`.
 * For `a.*`, returns the expression for `a`.
 * For `someFn().field`, returns the full `someFn()` expression.
 * For a bare atom like `x`, returns it unchanged.
 */
export function getRootExprOfFieldAccess(expr: Expr): Expr {
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, ".") &&
    expr.args.length >= 2
  ) {
    return getRootExprOfFieldAccess(expr.args[0]!);
  }
  return expr;
}

/**
 * Phase O (THREAD_SAFETY): Check if a field-access expression's root has
 * `atomic object` type, meaning writes through it are forbidden in safe code.
 * Returns the root type if it's atomic object, undefined otherwise.
 * Resolves SomeType (e.g., Self) to concrete types before checking.
 */
export function getAtomicObjectRootType(
  rootExpr: Expr,
  env: Environment
): Type | undefined {
  if (!exprIsAtom(rootExpr)) return undefined;
  const varName = rootExpr.token.value;
  if (!varName) return undefined;
  const variables = getVariablesFromEnv(env, varName);
  if (variables.length === 0) return undefined;
  const rootVar = variables[variables.length - 1]!;
  let rootType = rootVar.type;
  // Resolve SomeType (e.g., Self) to concrete type
  if (rootType && isSomeType(rootType)) {
    const resolved = getValueOfSomeTypeFromEnv(env, rootType);
    if (resolved) rootType = resolved;
  }
  if (rootType && isAtomicReferenceStructType(rootType)) {
    return rootType;
  }
  return undefined;
}

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
