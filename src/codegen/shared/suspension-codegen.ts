/**
 * suspension-codegen.ts
 *
 * Shared codegen utilities for state machine code generation.
 * Both async/await and algebraic effect state machines split function bodies
 * at suspension points and need tree-containment checks. This file provides
 * the generic versions of those operations.
 */

import type { SuspensionPoint } from "../../evaluator/shared/suspension-analysis-types";
import {
  exprIsAtomOf,
  exprIsFunctionCallOf,
  ExprTag,
  type Expr,
} from "../../expr";

/**
 * A code segment between suspension points.
 * Generic over the suspension point type (AwaitPoint or EffectCallPoint).
 */
export interface SuspensionSegment<P extends SuspensionPoint> {
  /** The state number this segment represents (0-based) */
  stateNumber: number;

  /** Expressions to execute in this state (before the suspension/return) */
  expressions: Expr[];

  /** The suspension point at the end of this segment (null for final segment) */
  suspensionPoint: P | null;
}

/**
 * Checks if an expression tree contains a specific target expression (by reference equality).
 *
 * @param shouldSkipBody Optional predicate to skip subtrees (e.g., nested async blocks
 *   that have their own state machine analysis and shouldn't be searched).
 */
export function containsSuspensionExpr(
  expr: Expr,
  targetExpr: Expr,
  shouldSkipBody?: (_expr: Expr) => boolean
): boolean {
  if (expr === targetExpr) {
    return true;
  }

  if (expr.tag === ExprTag.FnCall) {
    if (shouldSkipBody && shouldSkipBody(expr)) {
      return false;
    }
    if (containsSuspensionExpr(expr.func, targetExpr, shouldSkipBody)) {
      return true;
    }
    for (const arg of expr.args) {
      if (containsSuspensionExpr(arg, targetExpr, shouldSkipBody)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Finds the index of the first suspension point whose expression is contained
 * in `expr`. Returns -1 if no suspension point is found.
 */
export function findSuspensionInExpr<P extends SuspensionPoint>(
  expr: Expr,
  points: P[],
  shouldSkipBody?: (_expr: Expr) => boolean
): number {
  for (let i = 0; i < points.length; i++) {
    if (containsSuspensionExpr(expr, points[i]!.expr as Expr, shouldSkipBody)) {
      return i;
    }
  }
  return -1;
}

/**
 * Options for segment splitting.
 */
export interface SplitOptions {
  /**
   * Predicate to skip subtrees during containment checks
   * (e.g., nested async blocks).
   */
  shouldSkipBody?: (expr: Expr) => boolean;

  /**
   * If true, stop splitting when a `return` statement is encountered.
   * Async needs this; effects don't have explicit returns in SM bodies.
   */
  handleReturnStatements?: boolean;

  /**
   * If true, create empty segments for additional suspension points
   * found in the same expression (e.g., sequential awaits in a cond branch).
   * Async needs this; effects don't have sequential suspensions in one expression.
   */
  handleSequentialSuspensions?: boolean;
}

/**
 * Splits a function body at suspension points into sequential segments.
 *
 * For a `begin(expr1, expr2, ..., exprN)` block, finds which expressions contain
 * suspension points and partitions them into segments. Each segment's expressions
 * run in one state, and the suspension at the end triggers a state transition.
 *
 * @param body The function body expression
 * @param points All suspension points found in the body
 * @param options Configuration for system-specific split behavior
 */
export function splitBodyAtSuspensionPoints<P extends SuspensionPoint>(
  body: Expr,
  points: P[],
  options?: SplitOptions
): SuspensionSegment<P>[] {
  const segments: SuspensionSegment<P>[] = [];
  const shouldSkipBody = options?.shouldSkipBody;

  // Non-begin body: return as single segment
  if (body.tag !== ExprTag.FnCall || !exprIsFunctionCallOf(body, "begin")) {
    if (points.length === 0) {
      return [{ stateNumber: 0, expressions: [body], suspensionPoint: null }];
    }
    return [
      {
        stateNumber: 0,
        expressions: [body],
        suspensionPoint: points[0] ?? null,
      },
    ];
  }

  // Begin block — split at suspension point boundaries
  const expressions = body.args;
  const segmentExpressions: Expr[][] = [];
  let currentSegment: Expr[] = [];

  for (const expr of expressions) {
    const suspensionIndex = findSuspensionInExpr(expr, points, shouldSkipBody);

    // Check for return statements (async-specific)
    const isReturn =
      options?.handleReturnStatements &&
      (exprIsAtomOf(expr, "return") || exprIsFunctionCallOf(expr, "return"));

    if (suspensionIndex !== -1) {
      // Expression contains a suspension point — end this segment
      currentSegment.push(expr);
      segmentExpressions.push(currentSegment);
      currentSegment = [];

      // Handle sequential suspensions in the same expression (async-specific)
      if (options?.handleSequentialSuspensions) {
        for (let extra = suspensionIndex + 1; extra < points.length; extra++) {
          if (
            containsSuspensionExpr(
              expr,
              points[extra]!.expr as Expr,
              shouldSkipBody
            )
          ) {
            segmentExpressions.push([]); // Empty segment for extra suspension
          } else {
            break;
          }
        }
      }
    } else if (isReturn) {
      // Return statement — end segment and stop processing
      currentSegment.push(expr);
      segmentExpressions.push(currentSegment);
      currentSegment = [];
      break;
    } else {
      // Normal expression — accumulate
      currentSegment.push(expr);
    }
  }

  // Add final segment with remaining expressions
  if (currentSegment.length > 0) {
    segmentExpressions.push(currentSegment);
  }

  // Create typed segments
  for (let i = 0; i < segmentExpressions.length; i++) {
    const exprs = segmentExpressions[i]!;
    const suspensionPoint = i < points.length ? points[i]! : null;
    segments.push({ stateNumber: i, expressions: exprs, suspensionPoint });
  }

  return segments;
}
