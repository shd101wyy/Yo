/**
 * state-code-gen.ts
 *
 * Generates code for each state segment in an async state machine.
 * Splits the function body at await points and generates C code for each segment.
 */

import {
  BuiltinFunctions,
  Expr,
  ExprTag,
  exprIsFunctionCallOf,
} from "../../expr";
import { generateExpr } from "../expressions";
import { FunctionGenerationContext } from "../functions/context";
import { AwaitPoint } from "./await-analysis";

/**
 * Represents a code segment between await points.
 */
export interface StateSegment {
  /**
   * The state number this segment represents
   */
  stateNumber: number;

  /**
   * Expressions to execute in this state (before the await/return)
   */
  expressions: Expr[];

  /**
   * The await point at the end of this segment (null for final segment)
   */
  awaitPoint: AwaitPoint | null;
}

/**
 * Splits a function body into segments at await points.
 * Each segment contains the expressions to execute before reaching the next await.
 */
export function splitIntoStateSegments(
  body: Expr,
  awaitPoints: AwaitPoint[]
): StateSegment[] {
  const segments: StateSegment[] = [];

  // For now, we'll implement a simple version that handles the common case:
  // A begin block with sequential expressions containing await calls

  if (body.tag !== ExprTag.FuncCall || !exprIsFunctionCallOf(body, "begin")) {
    // Not a begin block - treat the whole body as one segment
    if (awaitPoints.length === 0) {
      return [
        {
          stateNumber: 0,
          expressions: [body],
          awaitPoint: null,
        },
      ];
    }

    // Single expression with awaits - for now, assume it's a single await
    return [
      {
        stateNumber: 0,
        expressions: [body],
        awaitPoint: awaitPoints[0] ?? null,
      },
    ];
  }

  // Begin block - split at await points
  const expressions = body.args;
  const segmentExpressions: Expr[][] = [];
  let currentSegment: Expr[] = [];

  for (const expr of expressions) {
    // Check if this expression contains an await
    const awaitIndex = findAwaitInExpr(expr, awaitPoints);

    if (awaitIndex !== -1) {
      // This expression contains an await
      currentSegment.push(expr);
      segmentExpressions.push(currentSegment);
      currentSegment = [];
    } else {
      // No await in this expression
      currentSegment.push(expr);
    }
  }

  // Add final segment if there are remaining expressions
  if (currentSegment.length > 0) {
    segmentExpressions.push(currentSegment);
  }

  // Create state segments
  for (let i = 0; i < segmentExpressions.length; i++) {
    const exprs = segmentExpressions[i]!;
    const awaitPoint = i < awaitPoints.length ? awaitPoints[i]! : null;

    segments.push({
      stateNumber: i,
      expressions: exprs,
      awaitPoint,
    });
  }

  return segments;
}

/**
 * Finds the index of an await point that matches an expression.
 * Returns -1 if no await is found in the expression.
 */
function findAwaitInExpr(expr: Expr, awaitPoints: AwaitPoint[]): number {
  for (let i = 0; i < awaitPoints.length; i++) {
    if (containsAwaitExpr(expr, awaitPoints[i]!.expr)) {
      return i;
    }
  }
  return -1;
}

/**
 * Checks if an expression contains a specific await expression.
 */
function containsAwaitExpr(expr: Expr, awaitExpr: Expr): boolean {
  if (expr === awaitExpr) {
    return true;
  }

  switch (expr.tag) {
    case ExprTag.FuncCall:
      if (containsAwaitExpr(expr.func, awaitExpr)) {
        return true;
      }
      for (const arg of expr.args) {
        if (containsAwaitExpr(arg, awaitExpr)) {
          return true;
        }
      }
      break;
  }

  return false;
}

/**
 * Generates C code for a state segment.
 * This handles code generation differently for state machine context:
 * - Variable assignments go to sm->var_xxx
 * - Await expressions trigger state transitions
 */
export function generateStateSegmentCode(
  segment: StateSegment,
  indent: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  for (let i = 0; i < segment.expressions.length; i++) {
    const expr = segment.expressions[i]!;

    // Check if this expression contains the await for this segment
    const isAwaitExpr =
      segment.awaitPoint && containsAwaitExpr(expr, segment.awaitPoint.expr);

    if (isAwaitExpr && segment.awaitPoint) {
      // This expression contains an await - handle specially
      generateAwaitExpression(
        expr,
        segment.awaitPoint,
        segment.stateNumber,
        indent,
        context
      );
    } else {
      // Regular expression - generate normally
      const code = generateExpr(expr, indent, context);
      if (code) {
        emitter.emitLine(`${indent}${code};`);
      }
    }
  }
}

/**
 * Generates code for an expression containing an await.
 * This handles the await specially by:
 * 1. Generating code up to the await
 * 2. Calling the async function and storing the Future
 * 3. Checking if the Future is ready and either continuing or yielding
 */
function generateAwaitExpression(
  expr: Expr,
  awaitPoint: AwaitPoint,
  _stateNumber: number,
  indent: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Check if this is a standalone await expression: await(futureExpr)
  if (
    expr.tag === ExprTag.FuncCall &&
    exprIsFunctionCallOf(expr, BuiltinFunctions.await)
  ) {
    // This is a standalone await: await(futureExpr)
    const futureExpr = expr.args[0];

    if (!futureExpr) {
      emitter.emitLine(`${indent}// Error: await without argument`);
      return;
    }

    // Generate the future expression - it should already be computed and stored
    // in a variable or state machine field
    const futureCode = generateExpr(futureExpr, indent, context);

    // Store the Future reference in the state machine for the await check
    emitter.emitLine(`${indent}// Prepare for await`);
    emitter.emitLine(
      `${indent}sm->await_future_${awaitPoint.index} = ${futureCode};`
    );

    return;
  }

  // Handle assignment with await: varName := await(futureExpr)
  if (expr.tag === ExprTag.FuncCall && exprIsFunctionCallOf(expr, ":=")) {
    // This is an assignment
    const varNameExpr = expr.args[0];
    const valueExpr = expr.args[1];

    if (!varNameExpr || !valueExpr) {
      emitter.emitLine(`${indent}// Error: Invalid assignment expression`);
      return;
    }

    // Check if the value is an await expression
    if (
      valueExpr.tag === ExprTag.FuncCall &&
      exprIsFunctionCallOf(valueExpr, BuiltinFunctions.await)
    ) {
      // This is: varName := await(futureExpr)
      const futureExpr = valueExpr.args[0];

      if (!futureExpr) {
        emitter.emitLine(`${indent}// Error: await without argument`);
        return;
      }

      // Generate the future expression (the async call before await)
      const futureCode = generateExpr(futureExpr, indent, context);

      // Get the variable name
      const varName = varNameExpr.token?.value;
      if (!varName || !varNameExpr.$) {
        emitter.emitLine(`${indent}// Error: Invalid variable name`);
        return;
      }

      // Store the Future in the state machine for the await check
      // The actual result extraction and variable assignment happens in the next state
      // (in state-machine.ts, after the result is extracted to await_result_X)
      emitter.emitLine(
        `${indent}// Store Future for await (variable: ${varName})`
      );
      emitter.emitLine(
        `${indent}sm->await_future_${awaitPoint.index} = ${futureCode};`
      );

      return;
    }
  }

  // Handle other patterns - for now, just generate a comment
  emitter.emitLine(`${indent}// TODO: Generate code for await expression`);
  const code = generateExpr(expr, indent, context);
  if (code) {
    emitter.emitLine(`${indent}${code};`);
  }
}
