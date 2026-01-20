import {
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  FnCallExpr,
} from "../../expr";
import { FunctionGenerationContext } from "../functions/context";
import { CodeGenContext } from "../utils";
import { generateExpr } from "./expr";

/**
 * Generate step expression for for loop increment section.
 * This generates the step expression inline without emitting it as a statement.
 */
function generateStepExpression(
  stepExpr: Expr,
  context: CodeGenContext
): string {
  // Handle begin blocks specially for multiple step expressions
  if (
    exprIsFunctionCall(stepExpr) &&
    exprIsFunctionCallOf(stepExpr, BuiltinKeywords.begin)
  ) {
    // Extract all assignment expressions from the begin block
    const assignments: string[] = [];

    for (const arg of stepExpr.args) {
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=", 2)) {
        const lhs = arg.args[0]!;
        const rhs = arg.args[1]!;

        const lhsCode = generateExpr(lhs, "", context);
        const rhsCode = generateExpr(rhs, "", context);

        assignments.push(`${lhsCode} = ${rhsCode}`);
      }
    }

    // Join multiple assignments with comma operator
    return assignments.join(", ");
  }
  // Handle single assignment expressions
  else if (
    exprIsFunctionCall(stepExpr) &&
    exprIsFunctionCallOf(stepExpr, "=", 2)
  ) {
    const lhs = stepExpr.args[0]!;
    const rhs = stepExpr.args[1]!;

    // For step expressions, we want inline assignment like "i = i + 1"
    const lhsCode = generateExpr(lhs, "", context);
    const rhsCode = generateExpr(rhs, "", context);

    return `${lhsCode} = ${rhsCode}`;
  }

  // For other expressions, just generate normally
  return generateExpr(stepExpr, "", context);
}

/**
 * Generate body statements for loop bodies.
 * This handles begin blocks by extracting their statements without the surrounding braces.
 */
function generateLoopBody(
  bodyExpr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  // Handle begin blocks specially for loop bodies
  if (
    exprIsFunctionCall(bodyExpr) &&
    exprIsFunctionCallOf(bodyExpr, BuiltinKeywords.begin)
  ) {
    // Update pendingDeferredDrops for this begin block
    // IMPORTANT: Concatenate with previous drops so early returns drop ALL enclosing scope vars
    const functionContext = context as FunctionGenerationContext;
    const previousPendingDeferredDrops = functionContext.pendingDeferredDrops;
    const currentDrops = bodyExpr.$?.deferredDropExpressions ?? [];
    functionContext.pendingDeferredDrops = [
      ...currentDrops,
      ...(previousPendingDeferredDrops ?? []),
    ];

    // Generate each statement in the begin block directly
    for (const arg of bodyExpr.args) {
      const argCode = generateExpr(arg, indent, context);
      if (argCode) {
        context.emitter.emitLine(`${indent}${argCode};`);
      }
    }

    // Generate deferred drop expressions before end of loop body
    if (bodyExpr.$?.deferredDropExpressions) {
      for (const dropExpr of bodyExpr.$.deferredDropExpressions) {
        const dropCode = generateExpr(dropExpr, indent, context);
        if (dropCode) {
          context.emitter.emitLine(`${indent}${dropCode};`);
        }
      }
    }

    // Restore previous pending deferred drops
    functionContext.pendingDeferredDrops = previousPendingDeferredDrops;
  } else {
    // For non-begin expressions, generate normally
    const bodyCode = generateExpr(bodyExpr, indent, context);
    if (bodyCode) {
      context.emitter.emitLine(`${indent}${bodyCode};`);
    }
  }
}

/**
 * Generate C code for while loop expression
 * Supports both while(condition, body) and while(condition, step, body) forms
 * The 3-argument form is transpiled to a C for loop, 2-argument form to a C while loop
 */
export function generateWhileLoop(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const args = expr.args;

  if (args.length === 2) {
    // 2-argument form: while(condition, body) -> C while loop
    // We need to re-evaluate the condition on each iteration, so we use while(true)
    // and check the condition inside with a break statement
    const conditionExpr = args[0]!;
    const bodyExpr = args[1]!;

    // Track that we're in a loop for proper break/continue handling in nested match expressions
    const savedLoopLabel = context.currentLoopLabel;
    const loopLabel = `loop_${Math.random().toString(36).substr(2, 9)}`;
    context.currentLoopLabel = loopLabel;

    context.emitter.emitLine(`${indent}while (true) {`);
    const conditionCode = generateExpr(conditionExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}  if (!(${conditionCode})) {`);
    context.emitter.emitLine(`${indent}    break;`);
    context.emitter.emitLine(`${indent}  }`);
    generateLoopBody(bodyExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}}`);
    context.emitter.emitLine(`${indent}${loopLabel}:;`);

    context.currentLoopLabel = savedLoopLabel;

    return "";
  } else if (args.length === 3) {
    // 3-argument form: while(condition, step, body) -> C for loop
    // We need to re-evaluate the condition on each iteration
    const conditionExpr = args[0]!;
    const stepExpr = args[1]!;
    const bodyExpr = args[2]!;

    // Track that we're in a loop for proper break/continue handling in nested match expressions
    const savedLoopLabel = context.currentLoopLabel;
    const savedContinueLabel = context.currentContinueLabel;
    const loopLabel = `loop_${Math.random().toString(36).substr(2, 9)}`;
    const continueLabel = `continue_${Math.random().toString(36).substr(2, 9)}`;
    context.currentLoopLabel = loopLabel;
    context.currentContinueLabel = continueLabel;

    context.emitter.emitLine(`${indent}while (true) {`);
    const conditionCode = generateExpr(conditionExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}  if (!(${conditionCode})) {`);
    context.emitter.emitLine(`${indent}    break;`);
    context.emitter.emitLine(`${indent}  }`);
    generateLoopBody(bodyExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}${continueLabel}:;`);
    const stepCode = generateStepExpression(stepExpr, context);
    context.emitter.emitLine(`${indent}  ${stepCode};`);
    context.emitter.emitLine(`${indent}}`);
    context.emitter.emitLine(`${indent}${loopLabel}:;`);

    context.currentLoopLabel = savedLoopLabel;
    context.currentContinueLabel = savedContinueLabel;

    return "";
  } else {
    context.emitter.emitLine(
      `${indent}/* Error: while loop expects 2 or 3 arguments, got ${args.length} */`
    );
    return "";
  }
}
