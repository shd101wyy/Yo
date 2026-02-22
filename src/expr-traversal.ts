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
 * Returns true if this expression is a `->` or `=>` that defines a new function boundary
 * (anonymous function, closure, or function type) that should NOT be recursed into
 * during abort/await traversal.
 *
 * Three cases are handled:
 * 1. Evaluated anonymous function: `expr.$?.isAnonymousFunctionDefinition === true`
 *    (set by evaluateAnonymousFunctionImplementation)
 * 2. Function type arrow: `fn(...) -> T` or `Fn(...) -> T`
 *    (set by evaluateFunctionType, recognized by syntax)
 * 3. Unevaluated anonymous function: `->` or `=>` with no `$` data.
 *    When a function body is deferred (e.g., because of forall parameters),
 *    inner anonymous functions won't have `$` data. We fall back to syntax:
 *    any `->` or `=>` whose LHS is NOT `fn(...)` / `Fn(...)` / `unsafe_fn(...)`
 *    is an anonymous function definition, not a cond/match branch arrow.
 *    (cond/match branches ALWAYS get `$` set because they're part of evaluated
 *    cond/match expressions — they're never inside a deferred body without `$`.)
 */
function isFunctionBoundaryArrow(expr: Expr): boolean {
  if (!exprIsFunctionCallOf(expr, ["->", "=>"])) return false;

  // Case 1: Evaluated anonymous function definition
  if (expr.$?.isAnonymousFunctionDefinition === true) return true;

  // Case 2: Function type arrow — fn(...) -> T or Fn(...) -> T
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCall(expr.func) &&
    (exprIsFunctionCallOf(expr.func, BuiltinKeywords.fn) ||
      exprIsFunctionCallOf(expr.func, BuiltinKeywords.unsafe_fn) ||
      exprIsFunctionCallOf(expr.func, BuiltinKeywords.Fn))
  ) {
    return true;
  }

  // Case 3: Unevaluated anonymous function — no $ data means the body was deferred
  // (function has forall parameters). In a deferred body, cond/match branches
  // already have their $ set (they're part of the enclosing evaluated expression),
  // so an arrow without $ is always an anonymous function definition.
  if (!expr.$) return true;

  return false;
}

/**
 * Traverse an EVALUATED function body expression tree to check if it contains
 * an `abort` keyword usage. This skips into nested scopes that would create
 * a new function boundary:
 * - `->` anonymous function value
 * - `=>` anonymous closure value (but NOT cond/match branch arrows)
 * - `fn(...) -> T` function type definitions
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
    if (isFunctionBoundaryArrow(expr)) {
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
 * Skips function boundaries (closures, async blocks) that create new scopes.
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
      isFunctionBoundaryArrow(expr) ||
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
