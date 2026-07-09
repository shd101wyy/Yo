/**
 * expr-traversal.ts
 *
 * Utility functions for traversing evaluated expression trees.
 * These are extracted to a separate file to prevent circular dependencies
 * between expr.ts and codegen modules.
 */

import { typeImplementsFn } from "./evaluator/trait-checking";
import {
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
} from "./expr";
import { isFunctionType } from "./types/guards";
import { isFunctionValue, isTypeValue } from "./value";

/**
 * Returns true if this expression is a `->` or `=>` that defines a new function boundary
 * (anonymous function, closure, or function type) that should NOT be recursed into
 * during escape/await traversal.
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

  // Case 1b: Arrow that evaluated to a FunctionValue via a non-anonymous-fn
  // evaluation path (e.g., module field value evaluation in function.ts).
  // These arrows are function implementations even though
  // isAnonymousFunctionDefinition was not set.
  if (expr.$?.value !== undefined && isFunctionValue(expr.$.value)) return true;

  // Case 2: Function type arrow — fn(...) -> T, ctl(...) -> T, or Fn(...) -> T
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCall(expr.func) &&
    (exprIsFunctionCallOf(expr.func, BuiltinKeywords.fn) ||
      exprIsFunctionCallOf(expr.func, BuiltinKeywords.ctl) ||
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
 * Returns true when every control-flow path through `expr` ends in an
 * `unwind(...)` (or another diverging call like `panic(...)`) — i.e. the
 * caller is guaranteed never to receive a normal return value.
 *
 * Used by `src/evaluator/exprs/assignment.ts` to relax the
 * "Runtime variables with generic function types are not allowed" check
 * when the bound lambda's body always unwinds. In that case the
 * forall-quantified return type is never delivered through the C
 * function pointer, so the ABI mismatch (one C fn pointer can't carry
 * different return shapes per monomorphization) is moot.
 *
 * Conservative: returns false whenever the analysis can't prove all
 * paths unwind. Honors function/closure boundaries the same way as
 * `evaluatedBodyContainsEscape` — a nested lambda or `fn(...) -> T`
 * value doesn't count as the surrounding body's exit (its body has its
 * own analysis when bound).
 */
export function allPathsUnwind(expr: Expr): boolean {
  if (!expr) return false;
  if (exprIsAtom(expr)) return false;
  if (!exprIsFunctionCall(expr)) return false;

  // Follow macro expansion the same way the other traversals do — the
  // pre-expansion shape is the source-level expression, and the
  // post-expansion shape is the form codegen actually sees.
  if (expr.$?.macroExpansion) {
    return allPathsUnwind(expr.$.macroExpansion);
  }

  // `unwind(...)` — never returns. (Bare atom `unwind` without a call
  // shouldn't appear in evaluated bodies; the FnCallOf check below is
  // the canonical form.)
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.unwind)) {
    return true;
  }
  // `return(...)` — resumes the continuation with a value. From the
  // caller's standpoint the function pointer DOES deliver this value,
  // which is exactly what the generic-fn-type ban guards against. So
  // `return` does NOT count as all-paths-unwind.
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
    return false;
  }
  // Builtin diverging calls: `panic(arg)`, `abort()`,
  // `unreachable()` — terminate the program. Match by callee atom name
  // so renames don't bypass the check silently.
  if (exprIsAtom(expr.func)) {
    const callee = expr.func.token.value;
    if (
      callee === "__yo_panic" ||
      callee === "abort" ||
      callee === "unreachable"
    ) {
      return true;
    }
  }

  // Nested function/closure boundary: `(args -> body)`, `(args => body)`,
  // `fn(...) -> T` types, `(fn(...) -> T)({...})` function-value
  // constructions. None of these contribute to the *surrounding* body's
  // control flow — they only execute when called from elsewhere. Mirror
  // the boundary skip used by `evaluatedBodyContainsEscape`.
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

  // `begin(s1, s2, ..., sn)` evaluates sequentially. If any `s_i` is
  // all-paths-unwind, control never reaches the rest — so the whole
  // begin is all-paths-unwind.
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
    for (const arg of expr.args) {
      if (allPathsUnwind(arg)) return true;
    }
    return false;
  }

  // `cond(arm1, arm2, ..., armN)` is all-paths-unwind iff
  //   (a) every arm's body is all-paths-unwind, AND
  //   (b) the arm set is exhaustive — i.e. there's a `true =>` or `_ =>`
  //       default arm. Without (b) the cond can fall through with no
  //       arm matching, and the surrounding expression returns normally.
  // `match(subject, arm1, ..., armN)` follows the same logic; the
  // subject (args[0]) is not an arm. A `_ =>` arm is the default.
  if (
    exprIsFunctionCallOf(expr, BuiltinKeywords.cond) ||
    exprIsFunctionCallOf(expr, BuiltinKeywords.match)
  ) {
    const isMatch = exprIsFunctionCallOf(expr, BuiltinKeywords.match);
    let hasDefault = false;
    let allArmsUnwind = true;
    let hasAnyArm = false;
    const armStart = isMatch ? 1 : 0;
    for (let i = armStart; i < expr.args.length; i++) {
      const arm = expr.args[i]!;
      if (!exprIsFunctionCall(arm) || !exprIsFunctionCallOf(arm, "=>")) {
        continue;
      }
      const armCondition = arm.args[0];
      const armBody = arm.args[1];
      if (!armBody) continue;
      hasAnyArm = true;
      if (
        armCondition &&
        (exprIsAtomOf(armCondition, "true") || exprIsAtomOf(armCondition, "_"))
      ) {
        hasDefault = true;
      }
      if (!allPathsUnwind(armBody)) {
        allArmsUnwind = false;
      }
    }
    return hasAnyArm && hasDefault && allArmsUnwind;
  }

  // `if(cond, then, else)` — both branches must be all-paths-unwind.
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.if) && expr.args.length >= 3) {
    const thenBranch = expr.args[1]!;
    const elseBranch = expr.args[2]!;
    return allPathsUnwind(thenBranch) && allPathsUnwind(elseBranch);
  }

  // Loops can exit normally — never all-paths-unwind from the outside.
  // A body that unwinds inside still doesn't guarantee the loop is
  // reached (zero-iteration), so we report false. `for` is a macro
  // that expands to a `while` so it falls through to the default
  // `return false` below.
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
    return false;
  }

  return false;
}

/**
 * Traverse an EVALUATED function body expression tree to check if it contains
 * an `escape` keyword usage. This skips into nested scopes that would create
 * a new function boundary:
 * - `->` anonymous function value
 * - `=>` anonymous closure value (but NOT cond/match branch arrows)
 * - `fn(...) -> T` function type definitions
 * - `(fn(...) -> T)({body})` function type call to create function value
 */
export function evaluatedBodyContainsEscape(expr: Expr): boolean {
  if (exprIsAtom(expr)) {
    return exprIsAtomOf(expr, BuiltinKeywords.unwind);
  }
  if (exprIsFunctionCall(expr)) {
    if (expr.$?.macroExpansion) {
      return evaluatedBodyContainsEscape(expr.$.macroExpansion);
    }

    // Handle cond/match explicitly — recurse into branches without treating => as function boundary
    if (
      exprIsFunctionCallOf(expr, BuiltinKeywords.cond) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.match)
    ) {
      return traverseCondMatchBranches(expr, evaluatedBodyContainsEscape);
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

    if (evaluatedBodyContainsEscape(expr.func)) {
      return true;
    }
    for (const arg of expr.args) {
      if (evaluatedBodyContainsEscape(arg)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Traverse an EVALUATED expression tree to check if it contains a `return`
 * or `escape` keyword. Follows the same boundary rules as
 * `evaluatedBodyContainsEscape`: skips function/closure boundaries but
 * recurses into cond/match branch arms.
 */
export function exprTreeContainsReturn(expr: Expr): boolean {
  if (exprIsAtom(expr)) {
    return (
      exprIsAtomOf(expr, BuiltinKeywords.return) ||
      exprIsAtomOf(expr, BuiltinKeywords.unwind)
    );
  }
  if (exprIsFunctionCall(expr)) {
    if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) return true;
    if (exprIsFunctionCallOf(expr, BuiltinKeywords.unwind)) return true;

    if (expr.$?.macroExpansion) {
      return exprTreeContainsReturn(expr.$.macroExpansion);
    }

    // Handle cond/match explicitly — recurse into branches without treating => as function boundary
    if (
      exprIsFunctionCallOf(expr, BuiltinKeywords.cond) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.match)
    ) {
      return traverseCondMatchBranches(expr, exprTreeContainsReturn);
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

    if (exprTreeContainsReturn(expr.func)) {
      return true;
    }
    for (const arg of expr.args) {
      if (exprTreeContainsReturn(arg)) {
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
    // Detect io.await(future) calls via the ioBuiltin marker
    if (expr.func.$?.type?.ioBuiltin === "io_await") {
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
      // Skip io.async(closure) calls — they create new async scopes
      expr.func.$?.type?.ioBuiltin === "io_async" ||
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

/**
 * Traverse an evaluated expression tree to check if it contains any
 * loop terminator (`break`, `return`, or `escape`). Follows the same
 * boundary rules as `evaluatedBodyContainsEscape`: skips function/closure
 * boundaries but recurses into cond/match branch arms.
 *
 * Used by the while loop evaluator to detect whether a `while true` body
 * can possibly terminate. Unlike `controlFlow` flags (which reflect
 * *guaranteed* control flow), this finds terminators in *any* branch.
 */
export function exprContainsLoopTerminator(expr: Expr): boolean {
  if (exprIsAtom(expr)) {
    return (
      exprIsAtomOf(expr, BuiltinKeywords.break) ||
      exprIsAtomOf(expr, BuiltinKeywords.return) ||
      exprIsAtomOf(expr, BuiltinKeywords.unwind)
    );
  }
  if (exprIsFunctionCall(expr)) {
    if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) return true;
    if (exprIsFunctionCallOf(expr, BuiltinKeywords.unwind)) return true;

    if (expr.$?.macroExpansion) {
      return exprContainsLoopTerminator(expr.$.macroExpansion);
    }

    // Handle cond/match explicitly — recurse into branches without treating => as function boundary
    if (
      exprIsFunctionCallOf(expr, BuiltinKeywords.cond) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.match)
    ) {
      return traverseCondMatchBranches(expr, exprContainsLoopTerminator);
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

    if (exprContainsLoopTerminator(expr.func)) {
      return true;
    }
    for (const arg of expr.args) {
      if (exprContainsLoopTerminator(arg)) {
        return true;
      }
    }
  }
  return false;
}
