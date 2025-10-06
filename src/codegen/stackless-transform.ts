/**
 * Stackless coroutine transformation utilities
 *
 * This module provides functions to detect suspension points in function bodies
 * and transform async functions into state machines.
 */

import {
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
} from "../expr";
import { isClosureType, isFunctionType } from "../types/guards";

/**
 * Check if an expression contains a suspension point (channel receive or select)
 * Suspension points are:
 * - Channel receive: `<-chan`
 * - Channel send: `chan <- value`
 * - Select statement: `select(...)`
 */
export function hasSuspensionPoint(expr: Expr): boolean {
  // Check if this is a function call
  if (exprIsFunctionCall(expr)) {
    // Skip nested function/closure bodies - they will be transformed separately
    // Pattern: (fn(params) -> return_type)({ body }) or (fn(params) => return_type)({ body })
    if (
      expr.func.$?.type &&
      (isFunctionType(expr.func.$.type) || isClosureType(expr.func.$.type))
    ) {
      // This is a function/closure invocation - don't check the body (it's in args)
      // Only check the function expression itself (signature), not the body
      if (hasSuspensionPoint(expr.func)) {
        return true;
      }
      // Don't recurse into args (the body) - skip them
      return false;
    }

    // Skip async blocks - they will be transformed separately
    // Pattern: async({ body })
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.async)) {
      return false;
    }

    // skip macro related as they are not suspension points
    if (
      exprIsFunctionCallOf(expr, BuiltinKeywords.quote) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.unquote) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.unquote_splicing) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.macro_expand)
    ) {
      return false;
    }

    // `<-` operator
    if (exprIsFunctionCallOf(expr, "<-")) {
      return true;
    }

    // Channel receive: `__yo_chan_recv`
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_chan_recv)) {
      return true;
    }

    // Channel send: `__yo_chan_send`
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_chan_send)) {
      return true;
    }

    // Select statement
    if (exprIsFunctionCallOf(expr, BuiltinKeywords.select)) {
      return true;
    }

    // Recursively check function expression and arguments
    if (hasSuspensionPoint(expr.func)) {
      return true;
    }
    for (const arg of expr.args) {
      if (hasSuspensionPoint(arg)) {
        return true;
      }
    }
  }

  // For atoms, no suspension points in literals or simple variables
  return false;
}

/**
 * Check if a function needs to be transformed into a state machine
 * This is true if:
 * 1. The function body contains suspension points (channel ops or select)
 * 2. The function is async (spawned with `async { ... }`)
 */
export function needsStateMachineTransformation(functionBody: Expr): boolean {
  return hasSuspensionPoint(functionBody);
}

/**
 * Represents a suspension point in the code (where task can be paused)
 */
export interface SuspensionPoint {
  type: "channel_recv" | "channel_send" | "select";
  stateId: number;
  expr: Expr;
}

/**
 * Extract all suspension points from a function body
 * Returns an array of suspension points with their state IDs
 */
export function extractSuspensionPoints(
  expr: Expr,
  stateCounter = { value: 1 }
): SuspensionPoint[] {
  const points: SuspensionPoint[] = [];

  // Check if this is a suspension point
  if (exprIsFunctionCall(expr)) {
    // Skip nested function/closure bodies - they will be transformed separately
    // Pattern: (fn(params) -> return_type)({ body }) or (fn(params) => return_type)({ body })
    if (
      expr.func.$?.type &&
      (isFunctionType(expr.func.$.type) || isClosureType(expr.func.$.type))
    ) {
      // This is a function/closure invocation - don't extract from the body (it's in args)
      // Only check the function expression itself (signature), not the body
      points.push(...extractSuspensionPoints(expr.func, stateCounter));
      // Don't recurse into args (the body) - skip them
      return points;
    }

    // Skip async blocks - they will be transformed separately
    // Pattern: async({ body })
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.async)) {
      return points; // Empty, don't recurse into async body
    }

    // Channel receive: `<-` or `__yo_chan_recv`
    if (
      exprIsFunctionCallOf(expr, "<-") ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_chan_recv)
    ) {
      points.push({
        type: "channel_recv",
        stateId: stateCounter.value++,
        expr: expr,
      });
      return points; // Don't recurse into suspension point arguments
    }

    // Channel send: `__yo_chan_send`
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_chan_send)) {
      points.push({
        type: "channel_send",
        stateId: stateCounter.value++,
        expr: expr,
      });
      return points; // Don't recurse into suspension point arguments
    }

    // Select statement
    if (exprIsFunctionCallOf(expr, BuiltinKeywords.select)) {
      points.push({
        type: "select",
        stateId: stateCounter.value++,
        expr: expr,
      });
      return points; // Don't recurse into select cases
    }

    // Recursively extract from function and arguments
    for (const arg of expr.args) {
      points.push(...extractSuspensionPoints(arg, stateCounter));
    }
    if (!exprIsFunctionCallOf(expr, BuiltinKeywords.quote)) {
      points.push(...extractSuspensionPoints(expr.func, stateCounter));
    }
  }

  return points;
}
