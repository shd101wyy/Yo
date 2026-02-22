/**
 * expr-traversal.ts
 *
 * Utility functions for traversing evaluated expression trees.
 * These are extracted to a separate file to prevent circular dependencies
 * between expr.ts and codegen modules.
 */

import { typeImplementsFn } from "./evaluator/trait-checking";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
} from "./expr";
import { isFunctionType } from "./types/guards";
import { isTypeValue } from "./value";

/**
 * Returns true if this `->` or `=>` expression defines an anonymous function or closure
 * (a new function boundary that should not be recursed into during traversal).
 * Cond/match branch arrows are NOT function definitions and must be recursed into.
 */
function isAnonymousFunctionDefinitionArrow(expr: Expr): boolean {
  if (!exprIsFunctionCallOf(expr, ["->", "=>"])) return false;
  return expr.$?.isAnonymousFunctionDefinition === true;
}

/**
 * Traverse an EVALUATED function body expression tree to check if it contains
 * an `abort` keyword usage. This skips into nested scopes that would create
 * a new function boundary:
 * - `->` anonymous function value
 * - `=>` anonymous closure value (but NOT cond/match branch arrows)
 * - `(fn(...) -> T)({body})` function type call to create function value
 */
export function evaluatedBodyContainsAbort(expr: Expr): boolean {
  if (exprIsAtom(expr)) {
    return exprIsAtomOf(expr, BuiltinKeywords.abort);
  }
  if (exprIsFunctionCall(expr)) {
    if (expr.$?.macroExpansion) {
      return evaluatedBodyContainsAbort(expr.$.macroExpansion);
    }
    if (
      exprIsFunctionCallOf(expr, BuiltinKeywords.fn) ||
      isAnonymousFunctionDefinitionArrow(expr)
    ) {
      return false;
    }
    if (
      exprIsFunctionCall(expr.func) &&
      expr.func.$?.value !== undefined &&
      isTypeValue(expr.func.$.value) &&
      isFunctionType(expr.func.$.value.value)
    ) {
      return false;
    }
    if (
      exprIsFunctionCall(expr.func) &&
      expr.func.$?.value !== undefined &&
      isTypeValue(expr.func.$.value) &&
      typeImplementsFn(expr.func.$.value.value)
    ) {
      return false;
    }

    if (evaluatedBodyContainsAbort(expr.func)) {
      return true;
    }
    for (const arg of expr.args) {
      if (evaluatedBodyContainsAbort(arg)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks if an expression contains any await expression.
 * Skips into function boundaries (closures, async blocks) that create new scopes.
 * Does NOT skip cond/match branch arrows, as those are not function boundaries.
 */
export function exprContainsAwait(expr: Expr): boolean {
  if (exprIsFunctionCall(expr)) {
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.await)) {
      return true;
    }

    if (expr.$?.macroExpansion) {
      return exprContainsAwait(expr.$.macroExpansion);
    }

    if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.async) ||
      isAnonymousFunctionDefinitionArrow(expr) ||
      (isTypeValue(expr.func.$?.value) &&
        isFunctionType(expr.func.$.value.value))
    ) {
      return false;
    }

    if (
      exprIsFunctionCall(expr.func) &&
      expr.func.$?.value !== undefined &&
      isTypeValue(expr.func.$.value) &&
      typeImplementsFn(expr.func.$.value.value)
    ) {
      return false;
    }

    if (exprContainsAwait(expr.func)) {
      return true;
    }
    for (const arg of expr.args) {
      if (exprContainsAwait(arg)) {
        return true;
      }
    }
  }

  return false;
}
