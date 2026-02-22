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
 * IMPORTANT: This function should NOT be called on `=>` that are direct children
 * of `cond(...)` or `match(...)` — those are branch arrows, not function boundaries.
 * The traversal functions handle cond/match explicitly to avoid this ambiguity.
 *
 * Two cases are handled:
 * 1. Evaluated anonymous function: `expr.$?.isAnonymousFunctionDefinition === true`
 *    (set by evaluateAnonymousFunctionImplementation)
 * 2. Function type arrow: `fn(...) -> T` or `Fn(...) -> T`
 *    (recognized by syntax: the LHS of `->` is a `fn`/`Fn`/`unsafe_fn` call)
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
  // (function has forall parameters). In a deferred body, the only way to reach
  // this function is through the explicit cond/match handling below, which skips
  // branch arrows. So any unrecognized arrow without $ is an anonymous function.
  if (!expr.$) return true;

  return false;
}

/**
 * Recurse into a cond or match expression's branch arms.
 * Branch arrows (`condition => body`) are NOT function boundaries — we recurse
 * directly into condition and body sub-expressions, bypassing `isFunctionBoundaryArrow`.
 */
function traverseCondMatchBranches(
  expr: Expr,
  visitor: (e: Expr) => boolean
): boolean {
  if (!exprIsFunctionCall(expr)) return false;
  if (visitor(expr.func)) {
    return true;
  }
  for (const arg of expr.args) {
    if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>")) {
      for (const branchPart of arg.args) {
        if (visitor(branchPart)) {
          return true;
        }
      }
    } else {
      if (visitor(arg)) {
        return true;
      }
    }
  }
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

    // Handle cond/match explicitly — recurse into branches without treating => as function boundary
    if (
      exprIsFunctionCallOf(expr, BuiltinKeywords.cond) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.match)
    ) {
      return traverseCondMatchBranches(expr, evaluatedBodyContainsAbort);
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

    // Handle cond/match explicitly — recurse into branches without treating => as function boundary
    if (
      exprIsFunctionCallOf(expr, BuiltinKeywords.cond) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.match)
    ) {
      return traverseCondMatchBranches(expr, exprContainsAwait);
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
